import { randomUUID } from "node:crypto";
import { createServer, get, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  errorCode, isTransient, LeaseLostError, loadSharedServer, PermanentError,
  type JobContext, type JobRecord, type QueueMessage, type Services, type SharedServer
} from "./contracts.js";
import { executeJob } from "./pipeline.js";

const processOwner = randomUUID();

export type JobExecutor = (
  services: Services, job: JobRecord, context: JobContext
) => Promise<{ outputUri?: string }>;

export interface WorkerOptions {
  execute: JobExecutor;
  isPermanentError: SharedServer["isPermanentError"];
  leaseSeconds?: number;
  heartbeatMs?: number;
  outboxMs?: number;
  receiveIdleMs?: number;
  retryBaseMs?: number;
  healthTimeoutMs?: number;
  log?: (event: string) => void;
}

function errorDiagnostic(error: unknown, sharedPermanent: SharedServer["isPermanentError"]): string {
  const code = errorCode(error);
  const httpCode = (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) ||
    (typeof code === "string" && /^[1-5]\d{2}$/.test(code)) ? String(code) : undefined;
  if (error instanceof LeaseLostError) return "lease-lost";
  if (typeof code === "string" && ["EACCES", "EPERM", "EROFS", "ENOSPC"].includes(code)) {
    return `local-filesystem:${code}`;
  }
  if (sharedPermanent(error)) return `shared-permanent${httpCode === undefined ? "" : `:${httpCode}`}`;
  if (error instanceof PermanentError) return `permanent${httpCode === undefined ? "" : `:${httpCode}`}`;
  if (typeof code === "string" && [
    "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EPIPE", "REQUEST_SEND_ERROR"
  ].includes(code)) {
    return `network:${code}`;
  }
  if (httpCode !== undefined) {
    return `remote-service:${httpCode}`;
  }
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "unknown";
}

function failureMessage(
  error: unknown, transient: boolean, retry: boolean, attempt: number, sharedPermanent: SharedServer["isPermanentError"]
): string {
  const diagnostic = errorDiagnostic(error, sharedPermanent);
  if (transient) {
    return retry
      ? `Transient job failure (${diagnostic}); retry scheduled`
      : `Transient job failure (${diagnostic}); retry budget exhausted`;
  }
  return attempt > 3
    ? `Retry budget exhausted (${diagnostic})`
    : `Permanent or non-transient job failure (${diagnostic})`;
}

export class Worker {
  readonly owner = processOwner;
  private readonly leaseSeconds: number;
  private readonly heartbeatMs: number;
  private readonly outboxMs: number;
  private readonly receiveIdleMs: number;
  private readonly retryBaseMs: number;
  private readonly healthTimeoutMs: number;
  private readonly log: (event: string) => void;
  private readonly stopped = new AbortController();
  private running = false;
  private active = false;
  private receiverAt = 0;
  private outboxAt = 0;
  private runPromise?: Promise<void>;

  constructor(readonly services: Services, private readonly options: WorkerOptions) {
    this.leaseSeconds = options.leaseSeconds ?? 120;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.outboxMs = options.outboxMs ?? 60_000;
    this.receiveIdleMs = options.receiveIdleMs ?? 1_000;
    this.retryBaseMs = options.retryBaseMs ?? 30_000;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 180_000;
    for (const value of [
      this.leaseSeconds, this.heartbeatMs, this.outboxMs, this.receiveIdleMs,
      this.retryBaseMs, this.healthTimeoutMs
    ]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid worker timing");
    }
    if (this.heartbeatMs >= this.leaseSeconds * 1_000) {
      throw new Error("Heartbeat must precede lease expiration");
    }
    this.log = options.log ?? (event => console.error(`[worker] ${event}`));
  }

  get healthy(): boolean {
    const now = Date.now();
    return this.running && !this.stopped.signal.aborted &&
      this.receiverAt > 0 && this.outboxAt > 0 &&
      now - this.receiverAt < this.healthTimeoutMs &&
      now - this.outboxAt < this.healthTimeoutMs;
  }

  stop(): void {
    // Only interrupt polling. The active job retains its own lease and signal.
    this.stopped.abort();
  }

  run(): Promise<void> {
    this.runPromise ??= this.runLoops();
    return this.runPromise;
  }

  private async wait(ms: number): Promise<void> {
    if (this.stopped.signal.aborted) return;
    await new Promise<void>(resolveWait => {
      const finish = () => {
        clearTimeout(timer);
        this.stopped.signal.removeEventListener("abort", finish);
        resolveWait();
      };
      const timer = setTimeout(finish, ms);
      this.stopped.signal.addEventListener("abort", finish, { once: true });
    });
  }

  private async runLoops(): Promise<void> {
    this.running = true;
    try {
      await Promise.all([this.pollOutbox(), this.receiveLoop()]);
    } finally {
      this.running = false;
    }
  }

  private async pollOutbox(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      try {
        const jobs = await this.services.store.recoverableJobs();
        for (const job of jobs) {
          if (this.stopped.signal.aborted) break;
          const due = Date.parse(job.nextDispatchAt);
          const lease = job.leaseUntil ? Date.parse(job.leaseUntil) : 0;
          if ((job.status === "queued" || job.status === "running") &&
              Number.isFinite(due) && due <= Date.now() &&
              Number.isFinite(lease) && lease <= Date.now()) {
            await this.services.queue.dispatch(job);
          }
        }
        this.outboxAt = Date.now();
      } catch {
        this.outboxAt = 0;
        this.log("outbox poll failed");
      }
      await this.wait(this.outboxMs);
    }
  }

  private async receiveLoop(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      try {
        const message = await this.services.queue.receive();
        this.receiverAt = Date.now();
        // A receive already in flight at shutdown may hide a message. Leave it
        // for visibility expiry rather than starting another job while draining.
        if (this.stopped.signal.aborted) break;
        if (message) await this.processMessage(message);
        else await this.wait(this.receiveIdleMs);
      } catch {
        this.receiverAt = 0;
        this.log("queue receive or processing failed");
        await this.wait(this.receiveIdleMs);
      }
    }
  }

  async processMessage(initialMessage: QueueMessage): Promise<void> {
    if (this.active) throw new Error("Worker already processing a job");
    this.active = true;
    try {
      await this.processClaim(initialMessage);
    } finally {
      this.active = false;
    }
  }

  private async processClaim(initialMessage: QueueMessage): Promise<void> {
    const claimStarted = Date.now();
    let job = await this.services.store.claimJob(initialMessage.jobId, this.owner, this.leaseSeconds);
    if (!job) {
      const canonical = await this.services.store.getJob(initialMessage.jobId);
      if (canonical?.status === "completed" || canonical?.status === "failed") {
        await this.services.queue.delete(initialMessage);
      }
      return;
    }

    const controller = new AbortController();
    let message = initialMessage;
    let deadline = claimStarted + this.leaseSeconds * 1_000;
    if (job.leaseUntil) deadline = Math.min(deadline, Date.parse(job.leaseUntil));
    let settled = false;
    let settling = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let tail: Promise<void> = Promise.resolve();
    const lose = () => {
      if (!controller.signal.aborted && !settled) {
        controller.abort(new LeaseLostError("Job lease lost"));
        this.receiverAt = 0;
        this.log("job lease lost");
      }
    };
    const assertOwned = () => {
      if (!Number.isFinite(deadline) || Date.now() >= deadline) lose();
      if (controller.signal.aborted || settled) throw new LeaseLostError("Job lease lost");
    };
    const armExpiry = () => {
      clearTimeout(expiry);
      expiry = setTimeout(lose, Math.max(0, deadline - Date.now()));
    };
    const serial = <T>(action: () => Promise<T>): Promise<T> => {
      const result = tail.then(async () => {
        assertOwned();
        try {
          return await action();
        } catch (error) {
          // Any failed ownership operation is ambiguous: never attempt a
          // compensating job write using the same claim.
          lose();
          throw error;
        }
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
    const renew = async () => {
      assertOwned();
      const started = Date.now();
      if (!await this.services.store.renewJob(job!.id, this.owner, this.leaseSeconds)) {
        lose();
        assertOwned();
      }
      assertOwned();
      message = await this.services.queue.renew(message, this.leaseSeconds);
      assertOwned();
      deadline = started + this.leaseSeconds * 1_000;
      armExpiry();
      this.receiverAt = Date.now();
    };
    const write = async (patch: Partial<JobRecord>) => {
      assertOwned();
      job = await this.services.store.updateOwnedJob(job!.id, this.owner, patch);
      assertOwned();
    };
    const context: JobContext = {
      signal: controller.signal,
      assertOwned,
      progress: (stage, progress) => {
        if (settling) return Promise.reject(new LeaseLostError("Job is settling"));
        return serial(() => write({ stage, progress }));
      }
    };
    const scheduleHeartbeat = () => {
      if (settling || controller.signal.aborted) return;
      heartbeat = setTimeout(() => {
        void serial(renew).catch(() => undefined).then(scheduleHeartbeat);
      }, this.heartbeatMs);
    };

    armExpiry();
    try {
      // Establish both leases before allowing pipeline side effects.
      await serial(renew);
      scheduleHeartbeat();
      const attempt = Math.max(1, job.attempts || 1);
      let output: { outputUri?: string } = {};
      let failure: unknown;
      let failed = false;
      try {
        if (attempt > 3) throw new PermanentError("Retry budget exhausted");
        output = await this.options.execute(this.services, job, context);
      } catch (error) {
        failed = true;
        failure = error;
        if (error instanceof LeaseLostError) lose();
      }

      settling = true;
      clearTimeout(heartbeat);
      await serial(async () => {
        // Serialized behind every heartbeat/progress operation, including any
        // renewal already in flight when the pipeline finished.
        await renew();
        if (failed) {
          const transient = isTransient(failure, this.options.isPermanentError);
          const retry = transient && attempt < 3;
          const error = failureMessage(failure, transient, retry, attempt, this.options.isPermanentError);
          this.log(`job ${job!.id} failed: ${error}`);
          // Reindex failure concerns one scene version, not the immutable video.
          // Its canonical graphStatus/job error already exposes failure; never
          // downgrade a video from an obsolete editorial job.
          if (job!.videoId && job!.kind === "ingest") {
            const video = await this.services.store.getVideo(job!.videoId);
            assertOwned();
            if (video) {
              await this.services.store.saveVideo({ ...video, status: "failed" });
              assertOwned();
            }
          }
          await write({
            status: retry ? "queued" : "failed",
            stage: `${retry ? "retry" : "failed"}:${job!.stage}`,
            error,
            ...(retry ? { nextDispatchAt: new Date(Date.now() + this.retryBaseMs * 2 ** (attempt - 1)).toISOString() } : {}),
            leaseUntil: new Date(0).toISOString()
          });
        } else {
          await write({
            status: "completed", stage: "completed", progress: 100,
            ...(output.outputUri === undefined ? {} : { outputUri: output.outputUri }),
            error: undefined, leaseUntil: new Date(0).toISOString()
          });
        }
        settled = true;
        clearTimeout(expiry);
      });
      // A failed delete is harmless: the canonical terminal/retry state is
      // already durable and a duplicate can be handled without executing it.
      await this.services.queue.delete(message);
    } catch {
      this.log(settled ? "settled queue message delete failed" : "job processing stopped without settlement");
    } finally {
      settling = true;
      clearTimeout(heartbeat);
      await tail;
      clearTimeout(expiry);
    }
  }
}

export function createHealthServer(worker: Pick<Worker, "healthy">): Server {
  return createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method !== "GET" || request.url !== "/healthz") {
      response.writeHead(404).end('{"status":"not-found"}');
      return;
    }
    const healthy = worker.healthy;
    response.writeHead(healthy ? 200 : 503).end(JSON.stringify({ status: healthy ? "ok" : "unavailable" }));
  });
}

export function checkHealth(port: number): Promise<boolean> {
  return new Promise(resolveCheck => {
    const request = get({ hostname: "127.0.0.1", port, path: "/healthz", timeout: 5_000 }, response => {
      response.resume();
      resolveCheck(response.statusCode === 200);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolveCheck(false));
  });
}

function workerPort(fallback: number): number {
  const port = process.env.WORKER_PORT === undefined ? fallback : Number(process.env.WORKER_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid worker port");
  return port;
}

export async function main(): Promise<void> {
  if (process.argv.includes("--healthcheck")) {
    const fallback = process.env.WORKER_PORT === undefined ? (await loadSharedServer()).loadConfig().port : 0;
    process.exitCode = await checkHealth(workerPort(fallback)) ? 0 : 1;
    return;
  }
  const shared = await loadSharedServer();
  const config = shared.loadConfig();
  const port = workerPort(config.port);
  const services = await shared.createServices(config);
  const worker = new Worker(services, {
    execute: (services, job, context) => executeJob(services, job, context, shared.sceneEmbeddingText),
    isPermanentError: error => shared.isPermanentError(error)
  });
  const server = createHealthServer(worker);
  const drain = () => worker.stop();
  process.on("SIGTERM", drain);
  process.on("SIGINT", drain);
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.removeListener("error", reject);
        resolveListen();
      });
    });
    await worker.run();
  } finally {
    worker.stop();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await services.graph.close?.();
    process.removeListener("SIGTERM", drain);
    process.removeListener("SIGINT", drain);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error("[worker] startup or runtime failure");
    process.exitCode = 1;
  });
}
