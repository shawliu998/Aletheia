import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkspaceDatabase } from "../lib/workspace/database";
import {
  WorkspaceJobLeaseLostError,
  WorkspaceJobsRepository,
} from "../lib/workspace/repositories/jobs";
import {
  WorkspaceJobAbortRegistry,
  WorkspaceJobsService,
  type WorkspaceJobHandler,
} from "../lib/workspace/services/jobs";
import {
  WorkspaceJobPump,
  type WorkspaceJobPumpTimer,
} from "../lib/workspace/jobs/pump";

const root = mkdtempSync(path.join(os.tmpdir(), "vera-workspace-job-pump-"));
const BASE_TIME = new Date("2026-07-15T00:00:00.000Z").getTime();

const IDS = {
  staleJob: "31111111-1111-4111-8111-111111111111",
  staleResource: "32111111-1111-4111-8111-111111111111",
  validJob: "33111111-1111-4111-8111-111111111111",
  validResource: "34111111-1111-4111-8111-111111111111",
  cancelJob: "35111111-1111-4111-8111-111111111111",
  cancelResource: "36111111-1111-4111-8111-111111111111",
  fairOne: "37111111-1111-4111-8111-111111111111",
  fairTwo: "38111111-1111-4111-8111-111111111111",
  fairThree: "39111111-1111-4111-8111-111111111111",
  fairResOne: "3a111111-1111-4111-8111-111111111111",
  fairResTwo: "3b111111-1111-4111-8111-111111111111",
  fairResThree: "3c111111-1111-4111-8111-111111111111",
  typedStaleWorkflowJob: "3c211111-1111-4111-8111-111111111111",
  typedStaleWorkflowRun: "3c311111-1111-4111-8111-111111111111",
  typedWorkflowJob: "3c411111-1111-4111-8111-111111111111",
  typedWorkflowRun: "3c511111-1111-4111-8111-111111111111",
  typedDocumentJob: "3c611111-1111-4111-8111-111111111111",
  typedDocumentResource: "3c711111-1111-4111-8111-111111111111",
  cancelPumpJob: "3d111111-1111-4111-8111-111111111111",
  cancelPumpResource: "3e111111-1111-4111-8111-111111111111",
  failJob: "3f111111-1111-4111-8111-111111111111",
  failResource: "40111111-1111-4111-8111-111111111111",
  okAfterFailJob: "41111111-1111-4111-8111-111111111111",
  okAfterFailResource: "42111111-1111-4111-8111-111111111111",
  leaseLostJob: "43111111-1111-4111-8111-111111111111",
  leaseLostResource: "44111111-1111-4111-8111-111111111111",
  staleFenceJob: "45111111-1111-4111-8111-111111111111",
  staleFenceResource: "46111111-1111-4111-8111-111111111111",
  stopJob: "47111111-1111-4111-8111-111111111111",
  stopResource: "48111111-1111-4111-8111-111111111111",
} as const;

class ManualTimer implements WorkspaceJobPumpTimer {
  private nowMs = BASE_TIME;
  private nextId = 1;
  private readonly tasks = new Map<
    number,
    { atMs: number; callback: () => void; cancelled: boolean }
  >();

  now(): Date {
    return new Date(this.nowMs);
  }

  setTimeout(callback: () => void, delayMs: number) {
    const id = this.nextId++;
    this.tasks.set(id, {
      atMs: this.nowMs + Math.max(0, delayMs),
      callback,
      cancelled: false,
    });
    return {
      cancel: () => {
        const task = this.tasks.get(id);
        if (task) task.cancelled = true;
      },
    };
  }

  async advanceBy(delayMs: number) {
    this.nowMs += delayMs;
    await this.flushReady();
  }

  async flushReady() {
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => !task.cancelled && task.atMs <= this.nowMs)
        .sort(
          (left, right) => left[1].atMs - right[1].atMs || left[0] - right[0],
        )[0];
      if (!next) return;
      this.tasks.delete(next[0]);
      next[1].callback();
      await flushMicrotasks();
    }
  }
}

function createDatabase(name: string) {
  return new WorkspaceDatabase(path.join(root, `${name}.db`));
}

function createRepository(database: WorkspaceDatabase) {
  return new WorkspaceJobsRepository(database);
}

function createService(
  repository: WorkspaceJobsRepository,
  timer: ManualTimer,
  abortRegistry: WorkspaceJobAbortRegistry,
  ids: readonly string[],
) {
  let index = 0;
  return new WorkspaceJobsService(repository, {
    now: () => timer.now(),
    createId: () => ids[index++] ?? randomUUID(),
    abortRegistry,
  });
}

function createPump(
  jobs: WorkspaceJobsService,
  timer: ManualTimer,
  abortRegistry: WorkspaceJobAbortRegistry,
  handlers: Record<string, WorkspaceJobHandler>,
  options: {
    concurrency?: number;
    idleBackoffMs?: number;
    maxIdleBackoffMs?: number;
    drainTimeoutMs?: number;
    leaseOwner?: string;
    leaseDurationMs?: number;
  } = {},
) {
  return new WorkspaceJobPump({
    jobs,
    handlers,
    abortRegistry,
    timer,
    concurrency: options.concurrency,
    idleBackoffMs: options.idleBackoffMs,
    maxIdleBackoffMs: options.maxIdleBackoffMs,
    drainTimeoutMs: options.drainTimeoutMs,
    leaseOwner: options.leaseOwner,
    leaseDurationMs: options.leaseDurationMs,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

async function auditRecoveryAndLifecycle() {
  const timer = new ManualTimer();
  const abortRegistry = new WorkspaceJobAbortRegistry();
  const database = createDatabase("recovery");
  try {
    const repository = createRepository(database);
    const service = createService(repository, timer, abortRegistry, [
      IDS.staleJob,
      IDS.validJob,
      IDS.cancelJob,
    ]);
    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.staleResource },
      resourceType: "document",
      resourceId: IDS.staleResource,
      maxAttempts: 2,
    });
    repository.claimNextQueued(
      timer.now().toISOString(),
      "stale-worker",
      timer.now().toISOString(),
    );

    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.validResource },
      resourceType: "document",
      resourceId: IDS.validResource,
      maxAttempts: 2,
    });
    const futureLease = new Date(timer.now().getTime() + 60_000).toISOString();
    repository.claimNextQueued(
      timer.now().toISOString(),
      "fresh-worker",
      futureLease,
    );

    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.cancelResource },
      resourceType: "document",
      resourceId: IDS.cancelResource,
      maxAttempts: 1,
    });
    repository.claimNextQueued(
      timer.now().toISOString(),
      "cancel-worker",
      timer.now().toISOString(),
    );
    service.requestCancellation(
      IDS.cancelJob,
      "user cancelled before recovery",
    );

    const pump = createPump(
      service,
      timer,
      abortRegistry,
      {
        document_parse: async () => ({ ok: true }),
      },
      { concurrency: 1, leaseOwner: "pump-worker" },
    );

    assert.equal(pump.capabilities.leaseHeartbeatSupported, true);
    assert.equal(pump.capabilities.leaseTokenFencingSupported, true);

    const started = await pump.start();
    assert.equal(started.alreadyStarted, false);
    const recoveredIds = new Map(
      started.recoveredJobs.map((job) => [job.id, job]),
    );
    assert.equal(recoveredIds.get(IDS.staleJob)?.status, "queued");
    assert.equal(recoveredIds.get(IDS.cancelJob)?.status, "cancelled");
    assert.equal(recoveredIds.has(IDS.validJob), false);
    assert.equal(repository.getJob(IDS.validJob)?.status, "running");

    const startedAgain = await pump.start();
    assert.equal(startedAgain.alreadyStarted, true);

    const stopped = await pump.stop();
    assert.equal(stopped.alreadyStopped, false);
    assert.equal(stopped.drained, true);

    const stoppedAgain = await pump.stop();
    assert.equal(stoppedAgain.alreadyStopped, true);
  } finally {
    database.close();
  }
}

async function auditConcurrencyAndFairness() {
  const timer = new ManualTimer();
  const abortRegistry = new WorkspaceJobAbortRegistry();
  const database = createDatabase("fairness");
  try {
    const repository = createRepository(database);
    const service = createService(repository, timer, abortRegistry, [
      IDS.fairOne,
      IDS.fairTwo,
      IDS.fairThree,
    ]);
    const order: string[] = [];
    const claims: Array<{ leaseOwner: string; attempt: number }> = [];
    let active = 0;
    let maxActive = 0;
    const controls = new Map<string, ReturnType<typeof deferred<unknown>>>();
    for (const jobId of [IDS.fairOne, IDS.fairTwo, IDS.fairThree]) {
      controls.set(jobId, deferred());
    }
    const handler: WorkspaceJobHandler = ({ job, claim }) => {
      assert.ok(claim, "fenced pump handlers receive their execution claim");
      claims.push(claim);
      order.push(job.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return controls.get(job.id)!.promise.finally(() => {
        active -= 1;
      });
    };
    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.fairResOne },
      resourceType: "document",
      resourceId: IDS.fairResOne,
      maxAttempts: 1,
    });
    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.fairResTwo },
      resourceType: "document",
      resourceId: IDS.fairResTwo,
      maxAttempts: 1,
    });
    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.fairResThree },
      resourceType: "document",
      resourceId: IDS.fairResThree,
      maxAttempts: 1,
    });

    const pump = createPump(
      service,
      timer,
      abortRegistry,
      { document_parse: handler },
      {
        concurrency: 2,
        idleBackoffMs: 10,
        maxIdleBackoffMs: 40,
        leaseOwner: "pump-fair",
      },
    );

    await pump.start();
    await flushMicrotasks();
    assert.equal(maxActive, 2);
    assert.deepEqual(order, [IDS.fairOne, IDS.fairTwo]);

    controls.get(IDS.fairOne)!.resolve({ done: 1 });
    controls.get(IDS.fairTwo)!.resolve({ done: 2 });
    await flushMicrotasks();
    assert.deepEqual(order, [IDS.fairOne, IDS.fairTwo, IDS.fairThree]);
    assert.equal(maxActive, 2);
    assert.deepEqual(claims, [
      { leaseOwner: "pump-fair", attempt: 1 },
      { leaseOwner: "pump-fair", attempt: 1 },
      { leaseOwner: "pump-fair", attempt: 1 },
    ]);

    controls.get(IDS.fairThree)!.resolve({ done: 3 });
    await flushMicrotasks();
    await pump.stop();
    assert.equal(repository.getJob(IDS.fairOne)?.status, "complete");
    assert.equal(repository.getJob(IDS.fairTwo)?.status, "complete");
    assert.equal(repository.getJob(IDS.fairThree)?.status, "complete");
  } finally {
    database.close();
  }
}

async function auditRegisteredHandlerTypeIsolation() {
  const timer = new ManualTimer();
  const abortRegistry = new WorkspaceJobAbortRegistry();
  const database = createDatabase("registered-types");
  try {
    const repository = createRepository(database);
    const service = createService(repository, timer, abortRegistry, [
      IDS.typedStaleWorkflowJob,
      IDS.typedWorkflowJob,
      IDS.typedDocumentJob,
    ]);

    service.createJob({
      type: "workflow_run",
      payload: { workflowRunId: IDS.typedStaleWorkflowRun },
      resourceType: "workflow_run",
      resourceId: IDS.typedStaleWorkflowRun,
      maxAttempts: 2,
      priority: 200,
    });
    const staleWorkflowClaim = repository.claimNextQueued(
      timer.now().toISOString(),
      "stale-workflow-worker",
      timer.now().toISOString(),
    );
    assert.equal(staleWorkflowClaim?.id, IDS.typedStaleWorkflowJob);

    service.createJob({
      type: "workflow_run",
      payload: { workflowRunId: IDS.typedWorkflowRun },
      resourceType: "workflow_run",
      resourceId: IDS.typedWorkflowRun,
      maxAttempts: 1,
      priority: 100,
    });
    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.typedDocumentResource },
      resourceType: "document",
      resourceId: IDS.typedDocumentResource,
      maxAttempts: 1,
      priority: 1,
    });

    assert.throws(
      () =>
        repository.claimNextQueuedForTypes(
          timer.now().toISOString(),
          [],
          "empty-allowlist-worker",
          new Date(timer.now().getTime() + 60_000).toISOString(),
        ),
      /at least one workspace job type/i,
    );
    assert.throws(
      () => createPump(service, timer, abortRegistry, {}),
      /at least one registered handler/i,
    );

    const documentExecutions: string[] = [];
    const documentClaims: Array<{ leaseOwner: string; attempt: number }> = [];
    const documentPump = createPump(
      service,
      timer,
      abortRegistry,
      {
        document_parse: ({ job, claim }) => {
          assert.ok(claim);
          documentExecutions.push(job.id);
          documentClaims.push(claim);
          return { parsed: job.resourceId };
        },
      },
      {
        concurrency: 1,
        idleBackoffMs: 5,
        maxIdleBackoffMs: 20,
        leaseOwner: "typed-document-pump",
      },
    );
    const documentStarted = await documentPump.start();
    assert.deepEqual(
      documentStarted.recoveredJobs.map((job) => job.id),
      [IDS.typedStaleWorkflowJob],
      "fenced recovery remains type-agnostic even when claims are type-filtered",
    );
    await flushMicrotasks(16);

    assert.deepEqual(documentExecutions, [IDS.typedDocumentJob]);
    assert.deepEqual(documentClaims, [
      { leaseOwner: "typed-document-pump", attempt: 1 },
    ]);
    assert.equal(repository.getJob(IDS.typedDocumentJob)?.status, "complete");
    for (const workflowJobId of [
      IDS.typedStaleWorkflowJob,
      IDS.typedWorkflowJob,
    ]) {
      const workflowJob = repository.getJob(workflowJobId);
      assert.equal(workflowJob?.status, "queued");
      assert.equal(workflowJob?.error, null);
    }
    assert.equal(repository.getJob(IDS.typedStaleWorkflowJob)?.attempt, 1);
    assert.equal(repository.getJob(IDS.typedWorkflowJob)?.attempt, 0);
    await documentPump.stop();

    const workflowExecutions: string[] = [];
    const workflowClaims: Array<{ leaseOwner: string; attempt: number }> = [];
    const workflowPump = createPump(
      service,
      timer,
      abortRegistry,
      {
        workflow_run: ({ job, claim }) => {
          assert.ok(claim);
          workflowExecutions.push(job.id);
          workflowClaims.push(claim);
          return { ran: job.resourceId };
        },
      },
      {
        concurrency: 1,
        idleBackoffMs: 5,
        maxIdleBackoffMs: 20,
        leaseOwner: "typed-workflow-pump",
      },
    );
    await workflowPump.start();
    await flushMicrotasks(24);
    assert.deepEqual(workflowExecutions, [
      IDS.typedStaleWorkflowJob,
      IDS.typedWorkflowJob,
    ]);
    assert.deepEqual(workflowClaims, [
      { leaseOwner: "typed-workflow-pump", attempt: 2 },
      { leaseOwner: "typed-workflow-pump", attempt: 1 },
    ]);
    assert.equal(
      repository.getJob(IDS.typedStaleWorkflowJob)?.status,
      "complete",
    );
    assert.equal(repository.getJob(IDS.typedWorkflowJob)?.status, "complete");
    await workflowPump.stop();
  } finally {
    database.close();
  }
}

async function auditCancellationAndIsolatedFailures() {
  const timer = new ManualTimer();
  const abortRegistry = new WorkspaceJobAbortRegistry();
  const database = createDatabase("cancel-fail");
  try {
    const repository = createRepository(database);
    const service = createService(repository, timer, abortRegistry, [
      IDS.cancelPumpJob,
      IDS.failJob,
      IDS.okAfterFailJob,
    ]);

    const cancellationHandler: WorkspaceJobHandler = ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
        void resolve;
      });

    let injectedTickFailure = true;
    const pump = createPump(
      service,
      timer,
      abortRegistry,
      {
        document_parse: async ({ job, signal }) => {
          if (job.id === IDS.cancelPumpJob) {
            return cancellationHandler({ job, signal });
          }
          if (job.id === IDS.failJob) {
            throw new Error("synthetic handler failure");
          }
          return { ok: job.id };
        },
      },
      {
        concurrency: 1,
        idleBackoffMs: 5,
        maxIdleBackoffMs: 20,
        leaseOwner: "pump-cancel",
      },
    );
    const originalClaimAndRun = pump.runtime.claimAndRun.bind(pump.runtime);
    pump.runtime.claimAndRun = async (signal?: AbortSignal) => {
      if (injectedTickFailure) {
        injectedTickFailure = false;
        throw new Error("synthetic tick failure");
      }
      return originalClaimAndRun(signal);
    };

    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.cancelPumpResource },
      resourceType: "document",
      resourceId: IDS.cancelPumpResource,
      maxAttempts: 1,
    });
    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.failResource },
      resourceType: "document",
      resourceId: IDS.failResource,
      maxAttempts: 1,
    });
    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.okAfterFailResource },
      resourceType: "document",
      resourceId: IDS.okAfterFailResource,
      maxAttempts: 1,
    });

    await pump.start();
    await flushMicrotasks();
    await timer.advanceBy(5);
    await flushMicrotasks();

    service.requestCancellation(IDS.cancelPumpJob, "cancel via registry");
    await flushMicrotasks();
    await timer.advanceBy(5);
    await flushMicrotasks();

    assert.equal(repository.getJob(IDS.cancelPumpJob)?.status, "cancelled");
    assert.equal(repository.getJob(IDS.failJob)?.status, "failed");
    assert.equal(repository.getJob(IDS.okAfterFailJob)?.status, "complete");
    await pump.stop();
  } finally {
    database.close();
  }
}

async function auditLeaseFencingAndTimeout() {
  const timer = new ManualTimer();
  const abortRegistry = new WorkspaceJobAbortRegistry();
  const database = createDatabase("lease");
  try {
    const repository = createRepository(database);
    const service = createService(repository, timer, abortRegistry, [
      IDS.staleFenceJob,
      IDS.leaseLostJob,
      IDS.stopJob,
    ]);

    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.staleFenceResource },
      resourceType: "document",
      resourceId: IDS.staleFenceResource,
      maxAttempts: 2,
    });
    const staleClaim = repository.claimNextQueued(
      timer.now().toISOString(),
      "old-worker",
      timer.now().toISOString(),
    )!;
    const recovered = repository.recoverStaleRunningJobs(
      timer.now().toISOString(),
    );
    assert.equal(recovered.length, 1);
    const reclaimed = repository.claimNextQueued(
      timer.now().toISOString(),
      "new-worker",
      new Date(timer.now().getTime() + 60_000).toISOString(),
    )!;
    assert.throws(
      () =>
        repository.finishClaim({
          id: staleClaim.id,
          leaseOwner: "old-worker",
          attempt: staleClaim.attempt,
          event: {
            type: "complete",
            at: timer.now().toISOString(),
            result: { stale: true },
          },
        }),
      WorkspaceJobLeaseLostError,
    );
    const completed = repository.finishClaim({
      id: reclaimed.id,
      leaseOwner: "new-worker",
      attempt: reclaimed.attempt,
      event: {
        type: "complete",
        at: timer.now().toISOString(),
        result: { fresh: true },
      },
    });
    assert.equal(completed.status, "complete");

    const leaseLostAbort = deferred<void>();
    const ignoredStop = deferred<unknown>();
    const abortedByLease: string[] = [];
    const pump = createPump(
      service,
      timer,
      abortRegistry,
      {
        document_parse: ({ job, signal }) => {
          if (job.id === IDS.leaseLostJob) {
            return new Promise((resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  abortedByLease.push(job.id);
                  leaseLostAbort.resolve();
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                },
                { once: true },
              );
            });
          }
          if (job.id === IDS.stopJob) {
            return ignoredStop.promise;
          }
          return { ok: true };
        },
      },
      {
        concurrency: 1,
        idleBackoffMs: 5,
        maxIdleBackoffMs: 20,
        drainTimeoutMs: 30,
        leaseOwner: "pump-lease",
        leaseDurationMs: 90,
      },
    );

    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.leaseLostResource },
      resourceType: "document",
      resourceId: IDS.leaseLostResource,
      maxAttempts: 2,
    });
    await pump.start();
    await flushMicrotasks();
    assert.equal(repository.getJob(IDS.leaseLostJob)?.status, "running");
    repository.releaseLease(
      IDS.leaseLostJob,
      "pump-lease",
      timer.now().toISOString(),
    );
    await timer.advanceBy(30);
    await flushMicrotasks();
    await leaseLostAbort.promise;
    assert.deepEqual(abortedByLease, [IDS.leaseLostJob]);
    await flushMicrotasks();
    const reclaimedAfterLoss = repository.getJob(IDS.leaseLostJob);
    assert.equal(reclaimedAfterLoss?.status, "running");
    assert.equal(
      reclaimedAfterLoss?.attempt,
      2,
      "the live pump recovers an expired lease and fences a new attempt without requiring a restart",
    );
    await pump.stop();

    service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.stopResource },
      resourceType: "document",
      resourceId: IDS.stopResource,
      maxAttempts: 1,
    });
    const stopPump = createPump(
      service,
      timer,
      abortRegistry,
      {
        document_parse: ({ job }) =>
          job.id === IDS.stopJob ? ignoredStop.promise : { ok: true },
      },
      {
        concurrency: 1,
        idleBackoffMs: 5,
        maxIdleBackoffMs: 20,
        drainTimeoutMs: 30,
        leaseOwner: "pump-stop",
        leaseDurationMs: 90,
      },
    );
    await stopPump.start();
    await flushMicrotasks();
    const stopPromise = stopPump.stop();
    await timer.advanceBy(30);
    const stopResult = await stopPromise;
    assert.equal(stopResult.drained, false);
    assert.equal(stopResult.restartBlocked, true);
    ignoredStop.resolve({ late: true });
    await flushMicrotasks();
    assert.notEqual(repository.getJob(IDS.stopJob)?.status, "complete");
  } finally {
    database.close();
  }
}

async function main() {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  await auditRecoveryAndLifecycle();
  await auditConcurrencyAndFairness();
  await auditRegisteredHandlerTypeIsolation();
  await auditCancellationAndIsolatedFailures();
  await auditLeaseFencingAndTimeout();
  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "vera-workspace-job-pump-v1",
        checks: [
          "pump start is idempotent and fenced recovery only touches stale running claims",
          "valid unexpired leases survive recovery while stale cancelled claims finalize to cancelled",
          "bounded concurrency respects the configured worker limit and preserves fair claim order",
          "production pumps claim only registered handler types while recovery remains type-agnostic",
          "unregistered queued jobs remain queued until their handler is registered, with empty allowlists rejected",
          "single tick failures and handler failures do not crash the pump",
          "shared AbortRegistry cancellation interrupts the active handler and finalizes cancelled",
          "heartbeat detects lease loss, the live pump reclaims expiry, and stale workers cannot finish a new attempt",
          "bounded stop returns on timeout and a late resolving ignored-abort handler does not complete the job",
        ],
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
