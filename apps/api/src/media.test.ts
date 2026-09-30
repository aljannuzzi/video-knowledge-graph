import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";
import express from "express";
import { asyncRoute, HttpError } from "./http.js";
import { mediaHandler } from "./media.js";

test("blob endpoint streams actual bytes, HEAD, ranges, conditional ranges and sanitized errors", async () => {
  const bytes = Buffer.from("0123456789abcdef");
  let downloads = 0;
  const services = {
    blobs: { client: {
      getContainerClient: (container: string) => {
        assert.ok(["videos", "evidence", "exports"].includes(container));
        return { getBlobClient: (name: string) => ({
          getProperties: async () => {
            if (name === "missing.mp4") throw { statusCode: 404, message: "private account details" };
            return { contentLength: bytes.length, etag: '"etag"', lastModified: new Date("2026-01-01T00:00:00Z") };
          },
          download: async (offset: number, count: number | undefined, options: {
            abortSignal: AbortSignal; conditions?: { ifMatch?: string }
          }) => {
            downloads++;
            assert.equal(options.conditions?.ifMatch, '"etag"');
            assert.ok(options.abortSignal instanceof AbortSignal);
            return { readableStreamBody: Readable.from([bytes.subarray(offset, count === undefined ? undefined : offset + count)]) };
          }
        }) };
      }
    } }
  } as unknown as Parameters<typeof mediaHandler>[0];
  const app = express();
  app.get("/api/media/:container/*", asyncRoute(mediaHandler(services)));
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error);
    res.status(error instanceof HttpError ? error.status : 500).json({
      error: error instanceof HttpError ? error.code : "internal_error"
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/media`;
  try {
    const full = await fetch(`${base}/videos/id/source.mp4`);
    assert.equal(full.status, 200);
    assert.equal(await full.text(), bytes.toString());
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.equal(full.headers.get("content-length"), "16");
    assert.equal(full.headers.get("cache-control"), "private, no-store");
    assert.equal(full.headers.get("accept-ranges"), "bytes");

    const beforeHead = downloads;
    const head = await fetch(`${base}/videos/id/source.mp4`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(downloads, beforeHead);
    for (const [range, text, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/16"],
      ["bytes=13-", "def", "bytes 13-15/16"],
      ["bytes=-3", "def", "bytes 13-15/16"]
    ]) {
      const response = await fetch(`${base}/videos/id/source.mp4`, { headers: { range } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), contentRange);
      assert.equal(await response.text(), text);
    }
    const stale = await fetch(`${base}/videos/id/source.mp4`, { headers: { range: "bytes=2-5", "if-range": '"old"' } });
    assert.equal(stale.status, 200);
    assert.equal(await stale.text(), bytes.toString());

    const invalid = await fetch(`${base}/videos/id/source.mp4`, { headers: { range: "bytes=99-" } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), "bytes */16");
    assert.deepEqual(await invalid.json(), { error: "invalid_range" });
    const missing = await fetch(`${base}/videos/missing.mp4`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "media_not_found" });
    assert.equal((await fetch(`${base}/secrets/password`)).status, 404);
    assert.equal((await fetch(`${base}/videos/id/%252e%252e/secret`)).status, 400);
    const archive = await fetch(`${base}/exports/job/clips.zip`);
    assert.equal(archive.headers.get("content-type"), "application/zip");
    assert.match(archive.headers.get("content-disposition")!, /^attachment;/);
    await archive.arrayBuffer();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
