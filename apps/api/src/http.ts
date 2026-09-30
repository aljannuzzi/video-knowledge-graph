import type { Request, Response, NextFunction, RequestHandler } from "express";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (request, response, next) => {
    void Promise.resolve().then(() => handler(request, response, next)).catch(next);
  };
}

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) {
    throw new HttpError(400, "invalid_identifier");
  }
  return value;
}

export function rateLimit(limit: number, windowMs: number): RequestHandler {
  const clients = new Map<string, { count: number; reset: number }>();
  let lastSweep = 0;
  return (request, response, next) => {
    const now = Date.now();
    if (now - lastSweep >= windowMs) {
      for (const [key, value] of clients) {
        if (value.reset <= now) clients.delete(key);
      }
      lastSweep = now;
    }
    // Forwarded headers are not trusted: they can be supplied by the caller.
    const key = request.socket.remoteAddress ?? "unknown";
    let client = clients.get(key);
    if (!client || client.reset <= now) {
      if (!client && clients.size >= 10_000) {
        response.setHeader("Retry-After", Math.ceil(windowMs / 1000));
        response.status(429).json({ error: "rate_limited" });
        return;
      }
      client = { count: 0, reset: now + windowMs };
      clients.set(key, client);
    }
    client.count++;
    if (client.count > limit) {
      response.setHeader("Retry-After", Math.ceil((client.reset - now) / 1000));
      response.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };
}
