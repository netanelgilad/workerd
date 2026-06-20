# Shared `/tmp` Virtual Filesystem (fork-only)

> **This is a deliberate sandbox relaxation for trusted self-hosted forks of workerd.**
> It is NOT in upstream `cloudflare/workerd` and should never be enabled for untrusted
> or mutually-distrusting workers. Default behavior is unchanged (isolated `/tmp`).

## What it does

By default, every workerd isolate gets its own private, in-memory writable `/tmp`
virtual filesystem. A Worker loaded dynamically at runtime via the **Worker Loader**
binding (`env.LOADER.get(...)` / `.load(...)`) therefore cannot see files the parent
worker wrote to `/tmp`, and vice-versa.

This patch adds an **opt-in** flag so a dynamically-loaded (child) worker can **share
one writable `/tmp` filesystem with the parent worker that loaded it**. Writes by either
side are immediately visible to the other.

## How to use it (Worker Loader API)

Pass `shareParentTmp: true` in the worker code object handed to the loader:

```js
export default {
  async fetch(req, env) {
    const stub = env.LOADER.get("my-child", async () => ({
      compatibilityDate: "2024-01-01",
      mainModule: "main.js",
      shareParentTmp: true,            // <-- OPT-IN. default: false
      modules: {
        "main.js": `
          export default {
            async fetch() {
              // This sees /tmp files written by the PARENT worker, and the
              // parent sees files this child writes. Same in-memory directory.
              const fs = await import("node:fs/promises");
              await fs.writeFile("/tmp/from-child.txt", "hello parent");
              return new Response("ok");
            }
          }
        `,
      },
    }));

    // Parent writes to /tmp before/around invoking the child...
    const fs = await import("node:fs/promises");
    await fs.writeFile("/tmp/from-parent.txt", "hello child");

    return stub.getEntrypoint().fetch(req);
  }
}
```

`shareParentTmp` also works with `env.LOADER.load(code)` (the shortcut for
`get(null, () => code)`).

When `shareParentTmp` is omitted or `false`, the child gets its own isolated `/tmp` —
identical to upstream workerd.

## Design

The `/tmp` VFS node (`TmpDirectory` in `src/workerd/io/worker-fs.c++`) is a pure
delegator: every operation resolves the *current* backing directory at access time from
`IoContext::current().getTmpDirStoreScope().getDirectory()`. The actual storage is a
single `kj::Rc<Directory> dir` held by the request's `TmpDirStoreScope`, which the
`IoContext` lazily creates.

So sharing `/tmp` reduces to making the child's `TmpDirStoreScope` wrap the **same**
`kj::Rc<Directory>` as the parent's, instead of allocating a fresh one.

### Core (`worker-fs.*`, `io-context.h`) — commit 1

- `TmpDirStoreScope::create(kj::Rc<Directory> shared)` — new factory (plus a badge ctor)
  that **wraps** an existing directory instead of calling `Directory::newWritable()`.
- `IoContext` gains `kj::Maybe<kj::Rc<Directory>> sharedTmpDir` + `setSharedTmpDir()`.
  `getTmpDirStoreScope()` builds the lazy scope around `sharedTmpDir` when present.

### Plumbing + opt-in (`worker-loader.*`, `io-channels.h`, `worker-entrypoint.*`,
`server.c++`) — commit 2

1. `WorkerLoader::WorkerCode` gains `jsg::Optional<bool> shareParentTmp = false`
   (the JS opt-in surface).
2. `WorkerLoader::toDynamicWorkerSource` captures the parent's `/tmp`
   `kj::Rc<Directory>` (from the live parent `IoContext`) when the flag is set, into
   `DynamicWorkerSource::sharedTmpDir`.
3. `server.c++` carries it: `DynamicWorkerSource` → `WorkerDef::sharedTmpDir` →
   stored on the dynamic `WorkerService` (long-lived, parent thread).
4. On each child request, `WorkerService::startRequest` forwards an `addRef` of the
   directory through `newWorkerEntrypoint` → `WorkerEntrypoint::init`, which calls
   `IoContext::setSharedTmpDir()` on the newly created child `IoContext` **before** its
   `/tmp` scope is materialized.

### Ownership / lifetime

The shared directory is a `kj::Rc<Directory>` held **by value** on the
`WorkerService` (which is owned by the `WorkerStubImpl` in the loader namespace, on the
parent thread, for the lifetime of the loaded isolate). This refcount keeps the
directory alive **independently of the parent `IoContext`**, so the child can keep using
`/tmp` even if the parent request finished and its `IoContext` was destroyed first.
Refcounted FS nodes are still destroyed under the isolate lock, exactly as before.

## Thread-safety limitation (read this)

**SAME-THREAD ONLY.** The in-memory directory implementation (`WritableDirectory`) is a
plain `kj::HashMap` behind a **non-atomic** `kj::Rc` — it is *not* thread-safe. Sharing a
single directory between two isolates is only safe because, in OSS workerd, a
Worker-Loader-spawned isolate **runs on the same thread as its parent** (see the
"we are single-threaded here" comment in `src/workerd/server/server.c++`).

If that single-thread invariant ever stops holding (e.g. a future change runs loaded
isolates on their own threads), this feature would introduce data races and must be
revisited (add locking, or use an atomic/thread-safe directory impl). Every code seam
touched by this patch is marked with a `FORK-ONLY (shared-tmp-vfs)` + `SAME-THREAD ONLY`
comment.

## Files changed

- `src/workerd/io/worker-fs.h` / `worker-fs.c++` — `TmpDirStoreScope` shared-dir factory
- `src/workerd/io/io-context.h` — `sharedTmpDir` field + `setSharedTmpDir()`
- `src/workerd/api/worker-loader.h` / `worker-loader.c++` — `shareParentTmp` opt-in + capture
- `src/workerd/io/io-channels.h` — `DynamicWorkerSource::sharedTmpDir` (+ clone)
- `src/workerd/io/worker-entrypoint.h` / `worker-entrypoint.c++` — thread param to IoContext
- `src/workerd/server/server.c++` — `WorkerDef`/`WorkerService` plumbing + injection

## Build / verification still needed

This was implemented without a full bazel build (intentionally — too heavy for this
environment). Before relying on it:

1. `bazel build //src/workerd/server:workerd` (or the project's normal build) to confirm
   it compiles.
2. Regenerate the TypeScript type snapshots (`types/generated-snapshot/*`) so
   `shareParentTmp` shows up in the generated `WorkerCode` types.
3. Add/run an integration test: a parent worker writes `/tmp/a`, loads a child with
   `shareParentTmp: true`, and asserts the child reads `/tmp/a` (and a `shareParentTmp:
   false` / omitted control asserts the child does NOT see it).
