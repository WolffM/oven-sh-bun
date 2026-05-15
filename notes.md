# Worker & worker_threads stability – reproduction notes

## Steps to reproduce

1. Install Bun (any recent version that uses the Rust-ported `web_worker.rs`).
2. Run the following script with `bun run <file>` (or inline with `bun -e`):

```js
// Rapid terminate() immediately after construction – pre-online race
for (let round = 0; round < 20; round++) {
  const workers = [];
  for (let i = 0; i < 40; i++) {
    const w = new Worker("data:text/javascript,setInterval(() => {}, 100000)");
    w.terminate(); // called before the worker thread may have even started
    workers.push(w);
  }
  await Promise.all(workers.map(w =>
    new Promise(r => w.addEventListener("close", r, { once: true }))
  ));
}

// Nested-worker / stale-context race
for (let i = 0; i < 12; i++) {
  const middle = new Worker(
    "data:text/javascript," +
    'const gc = new Worker("data:text/javascript,setTimeout(() => postMessage(1), 500)");' +
    'gc.addEventListener("message", () => {});'
  );
  await new Promise(r => middle.addEventListener("close", r, { once: true }));
  await new Promise(r => setTimeout(r, 600));
}

// Process exits while workers are still running
for (let i = 0; i < 24; i++) {
  new Worker("data:text/javascript,while(true){}");
}
setTimeout(() => process.exit(0), 50);
```

3. Alternatively, run the test suite directly:
   ```
   bun test test/js/node/worker_threads/worker-terminate-race.test.ts
   ```
4. For maximum reproduction fidelity build Bun with AddressSanitizer (ASAN) enabled and re-run:
   `BUN_ASAN=1 bun bd test test/js/node/worker_threads/worker-terminate-race.test.ts`

## Observed

- Non-zero exit codes and/or process crashes (SIGSEGV / SIGABRT) under
  AddressSanitizer when `terminate()` is called immediately after `new Worker()`
  while the worker thread is still inside `start_vm()`.
- ASAN reports a **use-after-free** in `setRefInternal` / `WebWorker__setRef`
  when the C++ `Worker` object is destroyed (via `~Worker` → `WebWorker__destroy`)
  concurrently with a still-running reference to the `WebWorker` struct held by
  the worker thread.
- In the nested-worker scenario the grandchild's `dispatchExit` attempts to
  post a close task to the middle worker's `ScriptExecutionContext`. If that
  context has already been removed from the global map the post returns `false`
  and the thread-held `Worker` ref plus `parent_poll_ref` are intentionally
  **leaked** (documented in `Worker::dispatchExit` in `Worker.cpp`). Over many
  iterations this grows unbounded RSS.
- `terminateAllAndWait` in `globalExit` has a time-bounded wait; workers that
  are still mid-`start_vm()` when the deadline passes may access resolver
  singletons (`dir_cache`, `dirname_store`) after those are freed by
  `transpiler.deinit()`, producing heap corruption under sanitizers.

## Expected

- `w.terminate()` called at any point in the Worker lifecycle – including
  before the thread has started, during `start_vm()`, during `spin()`, and
  after natural exit – must not produce crashes, use-after-free, or process
  non-zero exits.
- Nested workers whose parent context exits before they finish should silently
  drop their queued tasks (consistent with browser behaviour) without leaking
  the thread-held `Worker` ref.
- `process.exit()` while an arbitrary number of workers are running should
  complete cleanly; `terminateAllAndWait` must either stop every worker before
  the timeout or at minimum not UAF on resolver singletons for workers that
  have already passed the resolver-access checkpoint (`live_workers::unregister`).
- The open TODO – *"Make all usages of `*JSC.EventLoop` use a weak pointer or
  an integer for the ScriptExecutionContextID"* – must be resolved so that no
  code path dereferences the parent EventLoop raw pointer after the owning
  Worker has been destroyed, matching the safe identifier-based pattern already
  used by `ScriptExecutionContext::postTaskTo`.
