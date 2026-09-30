import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { HttpError, rateLimit } from "./http.js";

export type AuthConfig = {
  environment: "azure" | "local";
  authDisabled: boolean;
  appPassword: string;
  publicOrigin?: string;
};
const SESSION_MS = 8 * 60 * 60 * 1000;
const cookieName = "vkg_session";
const passwordSchema = z.object({ password: z.string().min(1).max(4096) }).strict();

export function validateAuthConfig(config: AuthConfig): void {
  if (config.authDisabled && config.environment !== "local") {
    throw new Error("Authentication can only be disabled in the local environment");
  }
  if (!config.authDisabled && (!config.appPassword || config.appPassword.length < 24)) {
    throw new Error("APP_PASSWORD must contain at least 24 characters");
  }
  if (config.publicOrigin) {
    const url = new URL(config.publicOrigin);
    if (
      url.origin !== config.publicOrigin ||
      !["http:", "https:"].includes(url.protocol) ||
      (config.environment === "azure" && url.protocol !== "https:")
    ) {
      throw new Error("PUBLIC_ORIGIN must be an exact origin (HTTPS in Azure)");
    }
  }
}

export function passwordMatches(input: string, expected: string): boolean {
  const hash = (text: string) => createHash("sha256").update(text, "utf8").digest();
  return timingSafeEqual(hash(input), hash(expected));
}

export function sessionSigner(password: string) {
  const key = scryptSync(password, "vkg-session-v1", 32);
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest();
  return {
    issue(now = Date.now()): string {
      const payload = Buffer.from(JSON.stringify({
        exp: now + SESSION_MS,
        nonce: randomBytes(24).toString("base64url")
      })).toString("base64url");
      return `${payload}.${sign(payload).toString("base64url")}`;
    },
    verify(token: string | undefined, now = Date.now()): boolean {
      if (!token || token.length > 1024) return false;
      const parts = token.split(".");
      if (parts.length !== 2 || parts.some((part) => !/^[\w-]+$/.test(part))) return false;
      const [payload, signature] = parts;
      const actual = Buffer.from(signature, "base64url");
      const expected = sign(payload);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
      try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return Number.isSafeInteger(data.exp) && data.exp > now && data.exp <= now + SESSION_MS &&
          typeof data.nonce === "string" && /^[\w-]{32}$/.test(data.nonce);
      } catch {
        return false;
      }
    }
  };
}

function cookie(request: Request): string | undefined {
  const matches = (request.headers.cookie ?? "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
  return matches.length === 1 ? matches[0].slice(cookieName.length + 1) : undefined;
}

function isLoopback(request: Request): boolean {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
}

function hasLocalHost(request: Request): boolean {
  const host = request.get("host") ?? "";
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host);
}

export function originAllowed(request: Request, config: AuthConfig): boolean {
  if (config.environment === "local" && config.authDisabled && !hasLocalHost(request)) return false;
  const origin = request.get("origin");
  if (!origin) return config.environment === "local" && config.authDisabled && isLoopback(request);
  try {
    const source = new URL(origin);
    if (source.origin !== origin || !["http:", "https:"].includes(source.protocol)) return false;
    const host = request.get("host");
    if (!host || !/^[a-zA-Z0-9.[\]:-]+$/.test(host)) return false;
    const expected = config.publicOrigin ??
      `${config.environment === "azure" ? "https" : request.protocol}://${host}`;
    return source.origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

export function createAuth(config: AuthConfig) {
  validateAuthConfig(config);
  const signer = sessionSigner(config.appPassword ?? "");
  const options = {
    httpOnly: true,
    secure: config.environment !== "local",
    sameSite: "strict" as const,
    path: "/"
  };
  const authenticated = (request: Request) => config.authDisabled
    ? config.environment === "local" && isLoopback(request) && hasLocalHost(request)
    : signer.verify(cookie(request));
  const csrf: RequestHandler = (request, _response, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !originAllowed(request, config)) {
      next(new HttpError(403, "invalid_origin"));
      return;
    }
    next();
  };
  const requireAuth: RequestHandler = (request, _response, next) => {
    next(authenticated(request) ? undefined : new HttpError(401, "authentication_required"));
  };
  const login: RequestHandler = (request, response, next) => {
    try {
      if (config.authDisabled) {
        if (!authenticated(request)) throw new HttpError(401, "authentication_required");
        response.json({ authenticated: true });
        return;
      }
      const { password } = passwordSchema.parse(request.body);
      if (!passwordMatches(password, config.appPassword)) throw new HttpError(401, "invalid_password");
      response.cookie(cookieName, signer.issue(), { ...options, maxAge: SESSION_MS });
      response.json({ authenticated: true });
    } catch (error) {
      next(error);
    }
  };
  return {
    csrf,
    requireAuth,
    login,
    loginLimit: rateLimit(10, 15 * 60 * 1000),
    status: (request: Request, response: Response) => response.json({ authenticated: authenticated(request) }),
    logout: (_request: Request, response: Response) => {
      response.clearCookie(cookieName, options);
      response.json({ authenticated: false });
    }
  };
}
