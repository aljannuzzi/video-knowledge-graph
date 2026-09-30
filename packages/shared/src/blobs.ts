import { BlobServiceClient } from "@azure/storage-blob";
import type { TokenCredential } from "@azure/core-auth";
import type { Config } from "./types.js";

const containers = new Set(["videos", "evidence", "exports"]);

function validate(container: string, name: string): void {
  if (!containers.has(container) || typeof name !== "string" || !name ||
      name.length > 1024 || /[\\\u0000-\u001f\u007f-\u009f]/.test(name) ||
      name.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid media location");
  }
}

export function mediaUri(container: string, name: string): string {
  validate(container, name);
  return `/api/media/${container}/${name.split("/").map(segment => encodeURIComponent(segment)).join("/")}`;
}

export function blobNameFromUri(uri: string): { container: string; name: string } {
  if (typeof uri !== "string" || !uri.startsWith("/api/media/") || /[?#\\\u0000-\u0020\u007f-\u009f]/.test(uri)) {
    throw new Error("Invalid media URI");
  }
  let segments: string[];
  try {
    segments = uri.slice("/api/media/".length).split("/").map(segment => decodeURIComponent(segment));
  } catch {
    throw new Error("Invalid media URI");
  }
  if (segments.length < 2 || segments.some(segment => /[\/\\]/.test(segment))) {
    throw new Error("Invalid media URI");
  }
  const container = segments[0]!;
  const name = segments.slice(1).join("/");
  validate(container, name);
  return { container, name };
}

function uploadConflict(error: unknown): boolean {
  const value = error as {
    statusCode?: number; code?: string; details?: { errorCode?: string };
  } | null;
  const code = value?.details?.errorCode ?? value?.code;
  return (value?.statusCode === 409 && code === "BlobAlreadyExists") ||
    (value?.statusCode === 412 && code === "ConditionNotMet");
}

export class Blobs {
  readonly client: BlobServiceClient;

  constructor(config: Config, credential: TokenCredential) {
    if (!/^[a-z0-9]{3,24}$/.test(config.storageAccount)) throw new Error("Invalid storage account");
    this.client = new BlobServiceClient(`https://${config.storageAccount}.blob.core.windows.net`, credential);
  }

  async uploadFile(container: string, name: string, path: string, contentType: string): Promise<string> {
    const uri = mediaUri(container, name);
    const blob = this.client.getContainerClient(container).getBlockBlobClient(name);
    try {
      await blob.uploadFile(path, {
        blobHTTPHeaders: { blobContentType: contentType },
        conditions: { ifNoneMatch: "*" }
      });
    } catch (error) {
      // Only the create-if-absent fence is success; lease/auth/other conflicts are not.
      if (!uploadConflict(error)) throw error;
    }
    return uri;
  }

  async downloadFile(container: string, name: string, path: string): Promise<void> {
    validate(container, name);
    await this.client.getContainerClient(container).getBlobClient(name).downloadToFile(path);
  }

  async delete(container: string, name: string): Promise<void> {
    validate(container, name);
    await this.client.getContainerClient(container).getBlobClient(name).deleteIfExists();
  }

  blobNameFromUri(uri: string): { container: string; name: string } {
    return blobNameFromUri(uri);
  }
}
