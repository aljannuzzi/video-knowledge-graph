import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import type { createServices } from "@vkg/shared/server";
import { HttpError } from "./http.js";
import { mediaPath, parseRange } from "./validation.js";

type Services = ReturnType<typeof createServices>;
const contentTypes: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mkv": "video/x-matroska", ".m4v": "video/mp4", ".avi": "video/x-msvideo",
  ".mpeg": "video/mpeg", ".mpg": "video/mpeg", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp", ".zip": "application/zip",
  ".json": "application/json"
};

export function contentType(name: string): string {
  return contentTypes[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

export function mediaHandler(services: Services) {
  return async (request: Request, response: Response) => {
    const { container, name } = mediaPath(request.params.container, request.params[0]);
    const blob = services.blobs.client.getContainerClient(container).getBlobClient(name);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      const properties = await blob.getProperties({ abortSignal: controller.signal });
      const size = properties.contentLength;
      if (size === undefined || !Number.isSafeInteger(size) || size < 0) throw new Error("Invalid blob length");
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Content-Type", contentType(name));
      response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      if (properties.etag) response.setHeader("ETag", properties.etag);
      if (properties.lastModified) response.setHeader("Last-Modified", properties.lastModified.toUTCString());
      const filename = path.posix.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
      response.setHeader("Content-Disposition", `${container === "exports" ? "attachment" : "inline"}; filename="${filename}"`);
      const ifRange = request.get("if-range");
      const rangeHeader = !ifRange || ifRange === properties.etag ||
        ifRange === properties.lastModified?.toUTCString() ? request.get("range") : undefined;
      let range;
      try {
        range = parseRange(rangeHeader, size);
      } catch (error) {
        if (error instanceof HttpError && error.status === 416) {
          response.setHeader("Content-Range", `bytes */${size}`);
        }
        throw error;
      }
      if (range) {
        response.status(206);
        response.setHeader("Content-Range", `bytes ${range.offset}-${range.offset + range.count - 1}/${size}`);
      }
      response.setHeader("Content-Length", range?.count ?? size);
      if (request.method === "HEAD" || size === 0) {
        response.end();
        return;
      }
      const download = await blob.download(range?.offset ?? 0, range?.count, {
        abortSignal: controller.signal,
        conditions: properties.etag ? { ifMatch: properties.etag } : undefined
      });
      if (!download.readableStreamBody) throw new Error("Blob download did not return a stream");
      await pipeline(download.readableStreamBody, response, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      // Do not retain a blob's length when sending a JSON error.
      if (!response.headersSent) {
        response.removeHeader("Content-Length");
        response.removeHeader("Content-Disposition");
        response.removeHeader("Content-Type");
      }
      if (error && typeof error === "object" && "statusCode" in error) {
        if (error.statusCode === 404) throw new HttpError(404, "media_not_found");
        if (error.statusCode === 412) throw new HttpError(409, "media_changed");
      }
      throw error;
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
    }
  };
}
