/**
 * Stability regression tests for Worker / worker_threads termination races.
 *
 * The underlying issue: Worker (both Web and Node flavours) is still marked
 * experimental in Bun. Known instability surface areas include:
 *
 *  1. Calling .terminate() on a worker that is still starting up
 *     (race between the spawn and the terminate).
 *  2. Nested workers where the middle thread exits while a grandchild is
 *     mid-flight, leaving the grandchild with a stale parent context.
 *  3. Rapid re-use of the same worker slot: create → terminate → create again
 *     in a tight loop stresses ScriptExecutionContextIdentifier reuse and
 *     EventLoop cleanup ordering.
 *
 * All tests spawn a fresh Bun subprocess so that a crash in the child does
 * not kill the test runner.
 */
import { expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug } from "harness";

const slow = isDebug || isASAN;
const timeout = slow ? 60_000 : 30_000;

// ---------------------------------------------------------------------------
// 1. terminate() immediately after construction (pre-online race)
//
// Regression target: the worker thread enters start_vm() concurrently with
// the parent calling terminate().  The early-terminate checkpoint in
// start_vm() must reach shutdown() without UAFing on self after dispatchExit
// posts (which drops the thread-held Worker ref, potentially freeing *this).
// ---------------------------------------------------------------------------
test(
  "terminate() immediately after construction does not crash",
  async () => {
    const rounds = slow ? 5 : 20;
    const perRound = slow ? 10 : 40;

    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
        for (let round = 0; round < ${rounds}; round++) {
          const workers = [];
          for (let i = 0; i < ${perRound}; i++) {
            // A worker with a long-running body so its thread is likely still
            // in start_vm() when we call terminate() from the parent.
            const w = new Worker("data:text/javascript,setInterval(() => {}, 100000)");
            // Terminate synchronously — the thread may not even have started yet.
            w.terminate();
            workers.push(w);
          }
          // Wait for every close event so the event loop drains cleanly.
          await Promise.all(workers.map(w => new Promise(r => w.addEventListener("close", r, { once: true }))));
        }
        console.log("ok");
      `,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout).toBe("ok\n");
    expect(exitCode).toBe(0);
  },
  timeout,
);

// ---------------------------------------------------------------------------
// 2. terminate() during message burst (in-flight postMessage race)
//
// Regression target: a parent posts many messages to a running worker and
// then calls terminate() while the drain task is still running inside
// drainToWorker().  The worker-side MessageInbox drain should observe
// requested_terminate and stop cleanly without UAF on the Worker ref.
// ---------------------------------------------------------------------------
test(
  "terminate() during in-flight postMessage burst does not crash",
  async () => {
    const rounds = slow ? 3 : 10;

    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
        for (let round = 0; round < ${rounds}; round++) {
          const w = new Worker("data:text/javascript,self.onmessage = () => {};");
          // Let the worker come online, then blast messages and terminate.
          await new Promise(r => w.addEventListener("open", r, { once: true }));
          for (let i = 0; i < 200; i++) w.postMessage(i);
          await w.terminate();
        }
        console.log("ok");
      `,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout).toBe("ok\n");
    expect(exitCode).toBe(0);
  },
  timeout,
);

// ---------------------------------------------------------------------------
// 3. Nested worker: grandchild posts messages after the middle worker exits
//
// Regression target: the EventLoop / ScriptExecutionContext of the middle
// worker must not be accessed as a raw pointer after it has been freed.
// Worker.cpp's postTaskToParent() uses a stable ScriptExecutionContextIdentifier
// and returns false when the context is gone — the grandchild's dispatchExit
// must tolerate that false return without crashing.
// ---------------------------------------------------------------------------
test(
  "grandchild worker outliving middle worker does not crash or UAF",
  async () => {
    const rounds = slow ? 4 : 12;

    // The grandchild sleeps 500 ms before posting a message back to its parent
    // (the middle worker).  We wait 700 ms (200 ms margin) to ensure the
    // grandchild has had a chance to fire its timer and attempt posting to the
    // now-dead middle context, exercising the stale-ScriptExecutionContext code
    // path in Worker::dispatchExit / postTaskToParent.
    const grandchildSleepMs = 500;
    const waitAfterMiddleExitsMs = 700;

    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
        for (let i = 0; i < ${rounds}; i++) {
          // Middle spawns a grandchild that sleeps, then middle exits immediately.
          const middle = new Worker(
            "data:text/javascript," +
            // Grandchild (variable named to avoid confusion with the garbage
            // collector) runs a long setTimeout so middle exits first.
            'const grandchild = new Worker("data:text/javascript,setTimeout(() => postMessage(1), ${grandchildSleepMs})");' +
            'grandchild.addEventListener("message", () => {});'
            // middle has no more work → its event loop drains → it exits
          );
          await new Promise(r => middle.addEventListener("close", r, { once: true }));
          // Wait ${waitAfterMiddleExitsMs} ms — long enough for the grandchild to fire its
          // ${grandchildSleepMs}-ms timer and attempt posting back to the already-removed
          // middle ScriptExecutionContext.
          await new Promise(r => setTimeout(r, ${waitAfterMiddleExitsMs}));
        }
        console.log("ok");
      `,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout).toBe("ok\n");
    expect(exitCode).toBe(0);
  },
  // Each round waits waitAfterMiddleExitsMs (700 ms); scale up for slow builds.
  slow ? 120_000 : 60_000,
);

// ---------------------------------------------------------------------------
// 4. worker_threads Worker: terminate() immediately after construction
//
// Same as test 1 but using the Node-flavour Worker from worker_threads.
// ---------------------------------------------------------------------------
test(
  "worker_threads: terminate() immediately after construction does not crash",
  async () => {
    const rounds = slow ? 5 : 20;
    const perRound = slow ? 10 : 40;

    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
        const { Worker } = require("worker_threads");
        for (let round = 0; round < ${rounds}; round++) {
          const workers = [];
          for (let i = 0; i < ${perRound}; i++) {
            const w = new Worker("setInterval(() => {}, 100000)", { eval: true });
            w.terminate();
            workers.push(w);
          }
          await Promise.all(workers.map(w => new Promise(r => w.once("exit", r))));
        }
        console.log("ok");
      `,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout).toBe("ok\n");
    expect(exitCode).toBe(0);
  },
  timeout,
);

// ---------------------------------------------------------------------------
// 5. Process exits while many workers are still running (terminateAllAndWait)
//
// Regression target: VirtualMachine::globalExit() calls terminateAllAndWait()
// before freeing process-global resolver state.  Workers that are mid-start
// or mid-spin when the exit fires must not UAF on dir_cache / dirname_store
// or any other singleton freed after the wait times out.
// ---------------------------------------------------------------------------
test(
  "process.exit() while many workers are running does not crash",
  async () => {
    const N = slow ? 8 : 24;

    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
        for (let i = 0; i < ${N}; i++) {
          // Workers run a busy loop so they are definitely alive when exit fires.
          new Worker("data:text/javascript,while(true){}");
        }
        // Give workers a moment to start, then exit abruptly.
        setTimeout(() => process.exit(0), 50);
      `,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    // stderr may contain worker termination noise; we only care about no crash.
    expect(exitCode).toBe(0);
  },
  timeout,
);
