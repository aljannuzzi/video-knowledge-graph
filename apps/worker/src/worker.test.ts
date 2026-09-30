import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { VideoAsset } from "@vkg/shared";
import { LeaseLostError, PermanentError, type JobContext, type JobRecord, type QueueMessage, type Services } from "./contracts.js";
import { checkHealth, createHealthServer, Worker, type WorkerOptions } from "./worker.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for worker");
    await delay(2);
  }
}

function fixture(overrides: Partial<JobRecord> = {}) {
  let job: JobRecord = {
    id: "job-1", kind: "ingest", videoId: "video-1", status: "queued",
    stage: "queued", progress: 0, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), payload: {}, attempts: 0,
    nextDispatchAt: new Date(0).toISOString(), ...overrides
  };
  const message: QueueMessage = { jobId: job.id, messageId: "message-1", popReceipt: "receipt-0" };
  const messages: QueueMessage[] = [];
  const writes: Array<{ owner: string; patch: Partial<JobRecord> }> = [];
  const renewals: QueueMessage[] = [];
  const deletes: QueueMessage[] = [];
  const dispatches: JobRecord[] = [];
  const events: string[] = [];
  const videos: VideoAsset[] = [];
  let recovery: JobRecord[] = [];
  let polls = 0;
  let receives = 0;
  let receipt = 0;
  let video: VideoAsset = {
    id: "video-1", title: "Video", filename: "video.mp4", status: "processing",
    createdAt: new Date().toISOString(), sceneCount: 0, jobId: job.id, assetUri: "asset"
  };
  const unused = async (): Promise<never> => { throw new Error("Unexpected service call"); };
  const services: Services = {
    config: {
      environment: "test", port: 8080, authDisabled: true, appPassword: "",
      visionDeployment: "vision", embeddingDeployment: "embedding", maxVideoSeconds: 180
    },
    store: {
      getVideo: async () => video,
      saveVideo: async value => { video = value; videos.push(value); },
      getJob: async () => job,
      listJobs: unused, createJob: unused, saveJob: unused,
      getScene: unused, listScenes: unused, saveScene: unused,
      claimJob: async (_id, owner, seconds) => {
        events.push("claim");
        if (job.status !== "queued" || Date.parse(job.nextDispatchAt) > Date.now()) return undefined;
        job = {
          ...job, status: "running", attempts: job.attempts + 1, leaseOwner: owner,
          leaseUntil: new Date(Date.now() + seconds * 1_000).toISOString()
        };
        return job;
      },
      renewJob: async (_id, owner) => {
        events.push("renew");
        return job.status === "running" && job.leaseOwner === owner;
      },
      updateOwnedJob: async (_id, owner, patch) => {
        assert.equal(owner, job.leaseOwner);
        assert.equal(job.status, "running");
        events.push(`write:${patch.status ?? patch.stage}`);
        writes.push({ owner, patch });
        job = { ...job, ...patch };
        return job;
      },
      recoverableJobs: async () => { polls++; return recovery; }
    },
    queue: {
      client: {},
      receive: async () => { receives++; return messages.shift(); },
      dispatch: async value => { dispatches.push(value); },
      renew: async (value, seconds) => {
        assert.equal(seconds, 120);
        assert.equal(value.popReceipt, `receipt-${receipt}`);
        renewals.push({ ...value });
        events.push("queue-renew");
        return { ...value, popReceipt: `receipt-${++receipt}` };
      },
      delete: async value => {
        events.push("delete");
        deletes.push({ ...value });
      }
    },
    blobs: { uploadFile: unused, downloadFile: unused, delete: unused, blobNameFromUri: () => { throw new Error("Unused"); } },
    ai: { analyzeFrames: unused, embed: unused },
    graph: { project: unused }
  };
  const makeWorker = (options: Partial<WorkerOptions> = {}) => new Worker(services, {
    execute: async () => ({}), isPermanentError: () => false,
    heartbeatMs: 10, outboxMs: 10, receiveIdleMs: 5,
    log: event => events.push(event), ...options
  });
  return {
    services, message, messages, writes, renewals, deletes, dispatches, events, videos, makeWorker,
    get job() { return job; },
    set job(value: JobRecord) { job = value; },
    get polls() { return polls; },
    get receives() { return receives; },
    set recovery(value: JobRecord[]) { recovery = value; }
  };
}

test("claims atomically, uses owned progress/completion, and deletes the latest receipt last", async () => {
  const f = fixture();
  const worker = f.makeWorker({
    execute: async (_services, claimed, context) => {
      assert.equal(claimed.attempts, 1);
      assert.equal(claimed.leaseOwner, worker.owner);
      await context.progress("analyzing", 50);
      await until(() => f.renewals.length >= 3);
      return { outputUri: "output.zip" };
    }
  });
  await worker.processMessage(f.message);
  assert.equal(f.job.status, "completed");
  assert.equal(f.job.outputUri, "output.zip");
  assert.equal(f.job.attempts, 1);
  assert.equal(f.job.progress, 100);
  assert(f.writes.every(write => write.owner === worker.owner && !("attempts" in write.patch)));
  assert.equal(f.deletes[0].popReceipt, `receipt-${f.renewals.length}`);
  assert.deepEqual(f.events.slice(-2), ["write:completed", "delete"]);
  assert.equal(worker.owner, f.makeWorker().owner);
});

for (const failure of ["canonical-false", "canonical-error", "queue-error"] as const) {
  test(`${failure} renewal aborts the pipeline and forbids every subsequent commit`, async () => {
    const f = fixture();
    let context!: JobContext;
    const worker = f.makeWorker({
      execute: async (_services, _job, current) => {
        context = current;
        await context.progress("analyzing", 25);
        if (failure === "queue-error") {
          f.services.queue.renew = async () => { throw new Error("secret credential"); };
        } else {
          f.services.store.renewJob = async () => {
            if (failure === "canonical-error") throw new Error("secret credential");
            return false;
          };
        }
        await new Promise<void>(done => context.signal.addEventListener("abort", () => done(), { once: true }));
        assert.throws(context.assertOwned, LeaseLostError);
        await assert.rejects(context.progress("must-not-commit", 90), LeaseLostError);
        return { outputUri: "must-not-commit.zip" };
      }
    });
    await worker.processMessage(f.message);
    assert.equal(context.signal.aborted, true);
    assert.equal(f.job.status, "running");
    assert.equal(f.writes.length, 1);
    assert.equal(f.deletes.length, 0);
    assert.equal(f.videos.length, 0);
    assert(!f.events.join(" ").includes("secret credential"));
  });
}

test("ambiguous owned progress failures abort instead of rescheduling with stale ownership", async () => {
  const f = fixture();
  let signal!: AbortSignal;
  f.services.store.updateOwnedJob = async () => { throw { statusCode: 503 }; };
  const worker = f.makeWorker({
    execute: async (_services, _job, context) => {
      signal = context.signal;
      await context.progress("analyzing", 10);
      return {};
    }
  });
  await worker.processMessage(f.message);
  assert(signal.aborted);
  assert.equal(f.job.status, "running");
  assert.equal(f.deletes.length, 0);
  assert.equal(f.videos.length, 0);
});

test("settlement waits for an in-flight renewal and never overlaps canonical operations", async () => {
  const f = fixture();
  const renewalStarted = deferred();
  const finishRenewal = deferred();
  const finishExecution = deferred();
  let renewCount = 0;
  let renewing = false;
  const normalRenew = f.services.store.renewJob;
  const normalWrite = f.services.store.updateOwnedJob;
  f.services.store.renewJob = async (...args) => {
    assert.equal(renewing, false);
    renewing = true;
    if (++renewCount === 2) {
      renewalStarted.resolve();
      await finishRenewal.promise;
    }
    const result = await normalRenew(...args);
    renewing = false;
    return result;
  };
  f.services.store.updateOwnedJob = async (...args) => {
    assert.equal(renewing, false);
    return normalWrite(...args);
  };
  const worker = f.makeWorker({ execute: async () => { await finishExecution.promise; return {}; } });
  const running = worker.processMessage(f.message);
  await renewalStarted.promise;
  finishExecution.resolve();
  await delay(35);
  assert.equal(renewCount, 2);
  assert.equal(f.writes.length, 0);
  assert.equal(f.deletes.length, 0);
  finishRenewal.resolve();
  await running;
  assert.equal(f.job.status, "completed");
  assert.equal(f.deletes[0].popReceipt, `receipt-${f.renewals.length}`);
});

test("a failed in-flight heartbeat wins over successful execution", async () => {
  const f = fixture();
  const renewalStarted = deferred();
  const releaseRenewal = deferred();
  const finishExecution = deferred();
  let count = 0;
  f.services.store.renewJob = async () => {
    if (++count === 2) {
      renewalStarted.resolve();
      await releaseRenewal.promise;
      return false;
    }
    return true;
  };
  const worker = f.makeWorker({ execute: async () => { await finishExecution.promise; return {}; } });
  const running = worker.processMessage(f.message);
  await renewalStarted.promise;
  finishExecution.resolve();
  releaseRenewal.resolve();
  await running;
  assert.equal(f.writes.length, 0);
  assert.equal(f.deletes.length, 0);
});

test("lease expiry aborts even while renewal is blocked and rejects its eventual success", async () => {
  const f = fixture();
  const releaseRenewal = deferred();
  let count = 0;
  let signal!: AbortSignal;
  f.services.store.renewJob = async () => {
    if (++count === 2) await releaseRenewal.promise;
    return true;
  };
  f.services.queue.renew = async message => message;
  const worker = f.makeWorker({
    leaseSeconds: 0.1,
    execute: async (_services, _job, context) => {
      signal = context.signal;
      await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true }));
      releaseRenewal.resolve();
      await assert.rejects(context.progress("expired", 90), LeaseLostError);
      return {};
    }
  });
  await worker.processMessage(f.message);
  assert(signal.aborted);
  assert.equal(count, 2);
  assert.equal(f.writes.length, 0);
  assert.equal(f.deletes.length, 0);
});

test("a refused initial renewal prevents all pipeline side effects", async () => {
  const f = fixture();
  f.services.store.renewJob = async () => false;
  await f.makeWorker({
    execute: async () => { assert.fail("Execution without both leases"); }
  }).processMessage(f.message);
  assert.equal(f.renewals.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.deletes.length, 0);
});

test("an ambiguous settlement failure is not followed by deletion or another write", async () => {
  const f = fixture();
  let writes = 0;
  let signal!: AbortSignal;
  f.services.store.updateOwnedJob = async () => { writes++; throw { statusCode: 503 }; };
  await f.makeWorker({
    execute: async (_services, _job, context) => { signal = context.signal; return {}; }
  }).processMessage(f.message);
  assert.equal(writes, 1);
  assert.equal(signal.aborted, true);
  assert.equal(f.deletes.length, 0);
});

test("delete failure preserves durable completion and the duplicate is not executed again", async () => {
  const f = fixture();
  const deleteMessage = f.services.queue.delete;
  f.services.queue.delete = async () => { throw { statusCode: 503 }; };
  await f.makeWorker().processMessage(f.message);
  assert.equal(f.job.status, "completed");
  assert.equal(f.writes.length, 1);
  f.services.queue.delete = deleteMessage;
  await f.makeWorker({
    execute: async () => { assert.fail("Completed job executed twice"); }
  }).processMessage({ ...f.message, popReceipt: "redelivered" });
  assert.equal(f.deletes[0].popReceipt, "redelivered");
  assert.equal(f.writes.length, 1);
});

for (const priorAttempts of [0, 1, 2, 3]) {
  test(`transient failure respects the atomic claim attempt budget (${priorAttempts} prior attempts)`, async () => {
    const f = fixture({ attempts: priorAttempts });
    let executions = 0;
    const before = Date.now();
    const worker = f.makeWorker({
      execute: async (_services, _job, context) => {
        executions++;
        await context.progress("embedding", 70);
        throw { statusCode: 503 };
      }
    });
    await worker.processMessage(f.message);
    assert.equal(f.job.attempts, priorAttempts + 1);
    assert.equal(executions, priorAttempts >= 3 ? 0 : 1);
    assert.equal(f.job.status, priorAttempts < 2 ? "queued" : "failed");
    if (priorAttempts >= 3) assert.equal(f.job.error, "Retry budget exhausted (permanent)");
    else assert.match(f.job.error ?? "", /Transient job failure \(remote-service:503\); retry (scheduled|budget exhausted)/);
    if (priorAttempts < 2) {
      assert.equal(f.job.stage, "retry:embedding");
      assert(Date.parse(f.job.nextDispatchAt) >= before + 30_000 * 2 ** priorAttempts);
      assert(Date.parse(f.job.leaseUntil!) < Date.now());
    }
    assert.equal(f.videos[0].status, "failed");
    assert.equal(f.deletes.length, 1);
    assert(f.events.indexOf("delete") > f.events.indexOf(`write:${f.job.status}`));
    assert(f.writes.every(write => !("attempts" in write.patch)));
  });
}

test("legacy zero-attempt claims count as attempt one without writing an increment", async () => {
  const f = fixture();
  f.services.store.claimJob = async (_id, owner) => {
    f.job = { ...f.job, attempts: 0, leaseOwner: owner, status: "running" };
    return f.job;
  };
  const before = Date.now();
  await f.makeWorker({ execute: async () => { throw { code: "ETIMEDOUT" }; } }).processMessage(f.message);
  assert.equal(f.job.status, "queued");
  assert.equal(f.job.attempts, 0);
  assert(Date.parse(f.job.nextDispatchAt) >= before + 30_000);
});

for (const kind of ["ingest", "reindex", "export"] as const) {
  for (const [failure, diagnostic] of [
    ["local-permanent", "permanent"],
    ["shared-permanent", "shared-permanent:503"],
    ["unknown", "unknown"]
  ] as const) {
    test(`${failure} ${kind} errors are not retried and only ingest fails the immutable video`, async () => {
      const f = fixture({ kind });
      const worker = f.makeWorker({
        isPermanentError: () => failure === "shared-permanent",
        execute: async () => {
          if (failure === "local-permanent") throw new PermanentError("private payload");
          if (failure === "shared-permanent") throw { statusCode: 503 };
          throw new Error("private payload");
        }
      });
      await worker.processMessage(f.message);
      assert.equal(f.job.status, "failed");
      assert.equal(f.job.error, `Permanent or non-transient job failure (${diagnostic})`);
      assert.equal(f.videos.length, kind === "ingest" ? 1 : 0);
      assert.equal(f.deletes.length, 1);
      assert(!f.events.join(" ").includes("private payload"));
      assert(!f.job.error?.includes("private payload"));
    });
  }
}

test("filesystem failures expose only a safe diagnostic code", async () => {
  const f = fixture({ kind: "export" });
  await f.makeWorker({
    execute: async () => {
      throw Object.assign(new Error("EACCES: permission denied, mkdir '/private/source/path'"), { code: "EACCES" });
    }
  }).processMessage(f.message);
  assert.equal(f.job.error, "Permanent or non-transient job failure (local-filesystem:EACCES)");
  assert(!f.events.join(" ").includes("/private/source/path"));
});
test("unexpected error codes cannot leak private strings into job diagnostics", async () => {
  const f = fixture({ kind: "export" });
  await f.makeWorker({
    execute: async () => {
      throw Object.assign(new Error("private message"), { code: "private source or credential" });
    }
  }).processMessage(f.message);
  assert.equal(f.job.error, "Permanent or non-transient job failure (unknown)");
  assert(!f.events.join(" ").includes("private"));
});

for (const status of ["running", "queued", "completed", "failed"] as const) {
  test(`duplicate ${status} messages do not execute and only terminal duplicates are deleted`, async () => {
    const f = fixture({ status });
    f.services.store.claimJob = async () => undefined;
    await f.makeWorker({ execute: async () => { assert.fail("Duplicate executed"); } }).processMessage(f.message);
    assert.equal(f.writes.length, 0);
    assert.equal(f.renewals.length, 0);
    assert.equal(f.deletes.length, status === "completed" || status === "failed" ? 1 : 0);
  });
}

test("outbox runs independently during execution, then stops while the active job drains", async () => {
  const f = fixture();
  const finish = deferred();
  let context!: JobContext;
  const due = { ...f.job, id: "due" };
  const expired = { ...due, id: "expired", status: "running" as const, leaseUntil: new Date(0).toISOString() };
  f.recovery = [
    due, expired,
    { ...due, id: "future", nextDispatchAt: new Date(Date.now() + 60_000).toISOString() },
    { ...due, id: "leased", leaseUntil: new Date(Date.now() + 60_000).toISOString() },
    { ...due, id: "terminal", status: "completed" }
  ];
  f.messages.push(f.message);
  const worker = f.makeWorker({
    execute: async (_services, _job, current) => { context = current; await finish.promise; return {}; }
  });
  const running = worker.run();
  await until(() => Boolean(context) && f.polls >= 3 && worker.healthy);
  assert(f.dispatches.some(job => job.id === "due"));
  assert(f.dispatches.some(job => job.id === "expired"));
  assert(f.dispatches.every(job => job.id === "due" || job.id === "expired"));
  worker.stop();
  assert.equal(worker.healthy, false);
  assert.equal(context.signal.aborted, false);
  const polls = f.polls;
  const receives = f.receives;
  const renewals = f.renewals.length;
  await until(() => f.renewals.length > renewals);
  assert.equal(f.polls, polls);
  assert.equal(f.receives, receives);
  finish.resolve();
  await running;
  assert.equal(f.job.status, "completed");
  assert.equal(f.deletes.length, 1);
});

test("outbox recovers a rescheduled job only after its next dispatch time", async () => {
  const f = fixture();
  await f.makeWorker({ execute: async () => { throw { statusCode: 429 }; } }).processMessage(f.message);
  f.recovery = [f.job];
  const worker = f.makeWorker();
  const running = worker.run();
  try {
    await until(() => f.polls >= 2);
    assert.equal(f.dispatches.length, 0);
    f.recovery = [{ ...f.job, nextDispatchAt: new Date(0).toISOString() }];
    await until(() => f.dispatches.length > 0);
    assert.equal(f.dispatches[0].status, "queued");
    assert.equal(f.dispatches[0].attempts, 1);
  } finally {
    worker.stop();
    await running;
  }
});

test("shutdown during receive leaves the unclaimed message for visibility expiry", async () => {
  const f = fixture();
  const receiveStarted = deferred();
  const receive = deferred<QueueMessage>();
  f.services.queue.receive = () => { receiveStarted.resolve(); return receive.promise; };
  const worker = f.makeWorker();
  const running = worker.run();
  await receiveStarted.promise;
  worker.stop();
  receive.resolve(f.message);
  await running;
  assert(!f.events.includes("claim"));
  assert.equal(f.deletes.length, 0);
});

test("health reflects startup, poll/receiver failure, recovery, and draining", async () => {
  const f = fixture();
  const worker = f.makeWorker();
  const server = createHealthServer(worker);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  let running: Promise<void> | undefined;
  try {
    assert.equal(await checkHealth(port), false);
    running = worker.run();
    await until(() => worker.healthy);
    assert.equal(await checkHealth(port), true);
    const normalPoll = f.services.store.recoverableJobs;
    f.services.store.recoverableJobs = async () => { throw new Error("credential"); };
    await until(() => !worker.healthy);
    assert.equal(await checkHealth(port), false);
    f.services.store.recoverableJobs = normalPoll;
    await until(() => worker.healthy);
    const normalReceive = f.services.queue.receive;
    f.services.queue.receive = async () => { throw new Error("credential"); };
    await until(() => !worker.healthy);
    f.services.queue.receive = normalReceive;
    await until(() => worker.healthy);
    const status = await new Promise<number | undefined>(resolveStatus => {
      get({ hostname: "127.0.0.1", port, path: "/other" }, response => {
        response.resume();
        resolveStatus(response.statusCode);
      });
    });
    assert.equal(status, 404);
    worker.stop();
    assert.equal(await checkHealth(port), false);
    assert(!f.events.join(" ").includes("credential"));
  } finally {
    worker.stop();
    await running;
    await new Promise<void>(done => server.close(() => done()));
  }
});

for (const stalledLoop of ["receiver", "outbox"] as const) {
  test(`health becomes unavailable when the ${stalledLoop} stalls without throwing`, async () => {
    const f = fixture();
    const release = deferred();
    const worker = f.makeWorker({ healthTimeoutMs: 60 });
    const running = worker.run();
    try {
      await until(() => worker.healthy);
      if (stalledLoop === "receiver") {
        f.services.queue.receive = async () => { await release.promise; return undefined; };
      } else {
        f.services.store.recoverableJobs = async () => { await release.promise; return []; };
      }
      await until(() => !worker.healthy);
    } finally {
      worker.stop();
      release.resolve();
      await running;
    }
  });
}
