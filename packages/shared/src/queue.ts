import { QueueClient } from "@azure/storage-queue";
import type { TokenCredential } from "@azure/core-auth";
import type { Config, JobRecord, QueueMessage } from "./types.js";
import type { Store } from "./store.js";

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function decode(text: string): string | undefined {
  try {
    if (!text || text.length > 4096 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
      return undefined;
    }
    const bytes = Buffer.from(text, "base64");
    if (bytes.toString("base64") !== text) return undefined;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const id = (value as Record<string, unknown>).jobId;
    return validId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export class Queue {
  readonly client: QueueClient;

  constructor(config: Config, credential: TokenCredential, private readonly store: Store) {
    if (!/^[a-z0-9]{3,24}$/.test(config.storageAccount) ||
        !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.queueName) || config.queueName.includes("--")) {
      throw new Error("Invalid queue location");
    }
    this.client = new QueueClient(
      `https://${config.storageAccount}.queue.core.windows.net/${config.queueName}`, credential
    );
  }

  async dispatch(job: JobRecord): Promise<void> {
    if (!validId(job.id)) throw new Error("Invalid job ID");
    const message = Buffer.from(JSON.stringify({ jobId: job.id }), "utf8").toString("base64");
    await this.client.sendMessage(message, { messageTimeToLive: 7 * 24 * 60 * 60, visibilityTimeout: 0 });
    // A crash before this marker can only duplicate delivery; claims fence execution.
    await this.store.noteDispatched(job.id);
  }

  async receive(): Promise<QueueMessage | undefined> {
    const response = await this.client.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 120 });
    const message = response.receivedMessageItems[0];
    if (!message) return undefined;
    const jobId = decode(message.messageText);
    if (!jobId) {
      await this.client.deleteMessage(message.messageId, message.popReceipt);
      return undefined;
    }
    return { jobId, messageId: message.messageId, popReceipt: message.popReceipt };
  }

  async renew(message: QueueMessage, seconds: number): Promise<QueueMessage> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 604800) throw new Error("Invalid visibility duration");
    const response = await this.client.updateMessage(message.messageId, message.popReceipt, undefined, seconds);
    if (!response.popReceipt) throw new Error("Missing queue receipt");
    return { ...message, popReceipt: response.popReceipt };
  }

  async delete(message: QueueMessage): Promise<void> {
    await this.client.deleteMessage(message.messageId, message.popReceipt);
  }
}
