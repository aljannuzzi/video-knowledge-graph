import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type Request } from "express";
import { createAuth, originAllowed, passwordMatches, sessionSigner, validateAuthConfig } from "./auth.js";
import { HttpError } from "./http.js";

const password = "correct-horse-battery-staple-12345";
const azure = { environment: "azure" as const, authDisabled: false, appPassword: password };
const local = { environment: "local" as const, authDisabled: true, appPassword: "" };
const request = (headers: Record<string, string>, remoteAddress = "127.0.0.1") => ({
  headers,
  get: (name: string) => headers[name],
  protocol: "http",
  socket: { remoteAddress }
} as unknown as Request);

test("sessions are signed, expiring, password-bound, and malformed-safe", () => {
  const signer = sessionSigner(password);
  const now = Date.now();
  const token = signer.issue(now);
  assert.ok(signer.verify(token, now));
  assert.equal(signer.verify(token, now + 8 * 60 * 60 * 1000), false);
  assert.equal(signer.verify(token, now - 1), false);
  assert.equal(sessionSigner(`${password}!`).verify(token, now), false);
  for (const value of [undefined, "", "a.b", `${token}.x`, token.replace(/^./, "!"), `${token.slice(0, -4)}AAAA`]) {
    assert.equal(signer.verify(value, now), false);
  }
});

test("password comparison handles different lengths without throwing", () => {
  assert.ok(passwordMatches(password, password));
  assert.equal(passwordMatches("", password), false);
  assert.equal(passwordMatches(`${password}!`, password), false);
  assert.equal(passwordMatches("wrong", password), false);
});

test("startup rejects unsafe auth and origin settings", () => {
  assert.throws(() => validateAuthConfig({ ...azure, authDisabled: true }));
  assert.throws(() => validateAuthConfig({ ...azure, appPassword: "short" }));
  assert.throws(() => validateAuthConfig({ ...azure, publicOrigin: "http://example.com" }));
  assert.throws(() => validateAuthConfig({ ...azure, publicOrigin: "https://example.com/path" }));
  assert.doesNotThrow(() => validateAuthConfig({ ...azure, publicOrigin: "https://example.com" }));
  assert.doesNotThrow(() => validateAuthConfig(local));
});

test("CSRF honors HTTPS host behind ACA without trusting forwarded headers", () => {
  assert.ok(originAllowed(request({ host: "app.example", origin: "https://app.example" }), azure));
  assert.equal(originAllowed(request({ host: "app.example" }), azure), false);
  assert.equal(originAllowed(request({ host: "app.example", origin: "null" }), azure), false);
  assert.equal(originAllowed(request({ host: "app.example", origin: "http://app.example" }), azure), false);
  assert.equal(originAllowed(request({
    host: "app.example", origin: "https://evil.example",
    "x-forwarded-host": "evil.example", "x-forwarded-proto": "https"
  }), azure), false);
  assert.equal(originAllowed(request({ host: "app.example@evil.example", origin: "https://evil.example" }), azure), false);
});

test("configured public origin supports an ingress host and rejects other origins", () => {
  const config = { ...azure, publicOrigin: "https://public.example" };
  assert.ok(originAllowed(request({ host: "internal.example", origin: "https://public.example" }), config));
  assert.equal(originAllowed(request({ host: "internal.example", origin: "https://internal.example" }), config), false);
});

test("origin omission is allowed only for explicit local loopback bypass", () => {
  assert.ok(originAllowed(request({ host: "localhost:8080" }), local));
  assert.equal(originAllowed(request({ host: "localhost:8080" }, "192.0.2.1"), local), false);
  assert.equal(originAllowed(request({ host: "localhost:8080" }), { ...local, authDisabled: false }), false);
  assert.equal(originAllowed(request({ host: "localhost:8080", origin: "https://evil.example" }), local), false);
  assert.equal(originAllowed(request({ host: "evil.example", origin: "http://evil.example" }), local), false);
  assert.equal(originAllowed(request({ host: "evil.example" }), local), false);
});

test("HTTP session login, protected route, logout, duplicate cookie rejection, and login rate limit", async () => {
  const auth = createAuth(azure);
  const app = express();
  app.use(auth.csrf);
  app.get("/api/session", auth.status);
  app.post("/api/session", auth.loginLimit, express.json(), auth.login);
  app.delete("/api/session", auth.logout);
  app.get("/api/private", auth.requireAuth, (_req, res) => res.json({ ok: true }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 400).json({ error: "request_failed" });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = base.replace("http:", "https:");
  try {
    assert.deepEqual(await (await fetch(`${base}/api/session`)).json(), { authenticated: false });
    assert.equal((await fetch(`${base}/api/private`)).status, 401);
    assert.equal((await fetch(`${base}/api/session`, { method: "POST" })).status, 403);
    const login = await fetch(`${base}/api/session`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    const sessionCookie = cookie.split(";")[0];
    assert.equal((await fetch(`${base}/api/private`, { headers: { cookie: sessionCookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/private`, {
      headers: { cookie: `${sessionCookie}; ${sessionCookie}` }
    })).status, 401);
    const logout = await fetch(`${base}/api/session`, { method: "DELETE", headers: { origin, cookie: sessionCookie } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie")!, /Expires=Thu, 01 Jan 1970/);
    for (let i = 0; i < 9; i++) {
      assert.equal((await fetch(`${base}/api/session`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: '{"password":"wrong"}'
      })).status, 401);
    }
    const limited = await fetch(`${base}/api/session`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password })
    });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("local bypass rejects DNS-rebinding hosts even for GET", () => {
  const auth = createAuth(local);
  const check = (headers: Record<string, string>): unknown => {
    let error: unknown;
    auth.requireAuth(request(headers), {} as express.Response, (value) => { error = value; });
    return error;
  };
  const rejected = check({ host: "attacker.example" });
  assert.ok(rejected instanceof HttpError && rejected.status === 401);
  assert.equal(check({ host: "127.0.0.1:8080" }), undefined);
  const forged = check({ host: "attacker.example", cookie: `vkg_session=${sessionSigner("").issue()}` });
  assert.ok(forged instanceof HttpError && forged.status === 401);
});
