# VFS Module Loading for Worker-Loader Children (fork feature)

> Branch: `feat/vfs-module-loading` (integrates `feat/shared-tmp-vfs` +
> `fix/native-fs-async-callbacks`). FORK-ONLY; not for upstream.

## What this enables

A dynamically-loaded (Worker-Loader) **child** isolate can now `import`/`require` JS
modules — **ESM and CJS, with full node-style resolution** (relative paths, bare
specifiers walked through `node_modules`, `package.json` `main`/`module`, file
extensions) — directly out of the **in-isolate VFS `/tmp`** it shares with its
parent.

Combined with the shared-`/tmp` feature, the child's `/tmp` *is* the parent Durable
Object's writable `/tmp`. So **npm-installed packages under `/tmp/node_modules` can be
loaded and RUN inside a child** by workerd's native module system — with no module
fallback service, no RPC, no socket, and no extra thread. This is the keystone for
running real npm code (and, next, Vite) from `/tmp` inside a child isolate.

## Opt-in API

Pass two options to the Worker Loader's `WorkerCode` (both default `false`):

```js
const child = env.loader.get("my-child", () => ({
  compatibilityDate: "2025-01-01",
  compatibilityFlags: ["nodejs_compat", "nodejs_compat_v2", "experimental", "enable_nodejs_fs_module"],
  allowExperimental: true,
  mainModule: "main.js",
  modules: { "main.js": "...child source..." },

  shareParentTmp: true,    // child's /tmp IS the parent's writable /tmp (shared-tmp-vfs feature)
  vfsModuleFallback: true, // resolve the child's imports/requires from that /tmp
}));
```

- `vfsModuleFallback: true` requires `shareParentTmp: true` (otherwise there is no
  shared `/tmp` to resolve against — the loader throws).
- Requires workerd to run with `--experimental`.
- Bare-specifier resolution walks `node_modules` from the importing module's directory
  up to `/tmp`. For a child `mainModule` (which lives in the bundle, not `/tmp`), seed
  the resolution base with `createRequire("/tmp/<dir>/index.js")` (its referrer
  directory roots the walk), or import by absolute `/tmp/...` path.

### Example: run a real npm package from the parent's `/tmp`

```js
// Parent DO: install left-pad into /tmp/proj/node_modules via @npmcli/arborist, then:
const child = env.LOADER.get("left-pad-child", () => ({
  compatibilityDate: "2025-01-01",
  compatibilityFlags: ["nodejs_compat", "nodejs_compat_v2", "experimental", "enable_nodejs_fs_module"],
  allowExperimental: true,
  shareParentTmp: true,
  vfsModuleFallback: true,
  mainModule: "main.js",
  modules: {
    "main.js": `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { createRequire } from "node:module";
      const require = createRequire("/tmp/proj/index.js");
      export default class extends WorkerEntrypoint {
        run() { return require("left-pad")("x", 5); }   // -> "    x"
      }
    `,
  },
}));
await child.getEntrypoint().run(); // "    x"
```

## Design

### The seam: a C++ module-fallback callback on the child isolate

workerd already has a per-isolate module-fallback hook
(`jsg::IsolateBase::setModuleFallbackCallback`), used in production by the HTTP
"module fallback service". Module resolution in workerd is **synchronous** (V8
instantiation is sync); the HTTP fallback offloads the blocking wait to a background
thread + socket. We don't need any of that: the shared `/tmp` is an **in-memory,
same-thread** `kj::Rc<Directory>`. So the child's fallback callback resolves and reads
modules from that directory **synchronously, in-process**.

Flow of the opt-in:

```
WorkerCode.vfsModuleFallback (api/worker-loader.h)
  -> DynamicWorkerSource.vfsModuleFallback (io/io-channels.h)
  -> Server::WorkerDef.vfsModuleFallback (server/server.c++)
  -> in makeWorkerImpl(): isolate->getApi().setModuleFallbackCallback(...)
       capturing the shared /tmp Directory + the child's feature flags
```

The callback delegates to `workerd::server::resolveModuleFromVfs(...)`
(`server/vfs-module-fallback.{h,c++}`), which performs node resolution against the
captured `/tmp` directory and returns either:
- a **redirect** (a workerd module specifier the registry resolves instead), or
- a capnp `Worker::Module` (source + type + named exports) that the caller compiles via
  `WorkerdApi::tryCompileModule`.

This ports the proven resolution + classification logic from the host harness
(`vite-workerd-demo/experiments/npm-in-workerd/host.mjs`) into C++.

### Two subtle but load-bearing decisions

1. **Resolve against the captured `Directory`, NOT `VirtualFileSystem::current(js)`.**
   Module resolution runs at worker **startup**, before any request injects the shared
   `/tmp` into the `IoContext`. At that point `VirtualFileSystem::current(js)` sees a
   *private, empty* `/tmp`. So the callback captures the shared `kj::Rc<Directory>`
   (the same object passed for `shareParentTmp`) in its closure and resolves against it
   directly. Reads still hold the isolate lock.

2. **Module names vs. redirects use different path forms.**
   The legacy registry identifies modules by **root-relative** `kj::Path` strings (no
   leading slash, e.g. `tmp/node_modules/left-pad/index.js`) — `kj::Path::parse`
   rejects a leading slash. But redirects are resolved by the registry via
   `specifier.parent().eval(redirect)`; a root-relative redirect would be wrongly joined
   onto the specifier's parent (`tmp` → `tmp/tmp/...`), causing an **infinite redirect
   loop**. `PathPtr::eval` drops the parent parts when the argument starts with `/`, so
   redirects use the **absolute** form (`/tmp/...`) while the compiled module's *name*
   uses the root-relative form. (See the comments in `resolveModuleFromVfs`.)

### Resolution semantics implemented (`vfs-module-fallback.c++`)

- Relative (`./`, `../`) and absolute (`/tmp/...`) specifiers.
- Bare specifiers (incl. scoped `@scope/pkg` and subpaths) via `node_modules` walking up
  to `/tmp`.
- **`package.json` conditional `exports` maps** (Node `PACKAGE_EXPORTS_RESOLVE` subset):
  - String sugar (`"exports": "./x.js"`) for the `.` entry.
  - Conditions objects (`import` / `require` / `module` / `node` / `default`, plus
    `development`→on / `production`→off). **`browser` is intentionally NOT honored** — we
    want the node/default build. `import` is selected for ESM, `require` for CJS; first
    matching condition wins in object insertion order.
  - Subpath exports (`"./feature": "./lib/feature.js"`), nested condition objects, and
    fallback arrays.
  - Subpath **patterns** (`"./*": "./dist/*.js"`) with `*` capture+substitution; longest
    matching prefix wins.
  - `exports` takes **precedence** over `main`/`module`, and **blocks** deep subpaths not
    listed in the map (Node behavior).
- **`package.json` `imports` maps** (`#`-prefixed private specifiers): exact + `*`-pattern
  keys, resolved against the nearest enclosing `package.json`; targets may be relative
  paths or bare specifiers (re-resolved through `node_modules`).
- Legacy fallback `package.json` field priority when no (matching) `exports`: `module`
  then `main` for import; `main` for require.
- Extension probing: `.js/.mjs/.cjs/.json` (import), `.js/.cjs/.json` (require);
  directory `index.*`.
- CJS vs ESM classification: by extension (`.mjs`→ESM, `.cjs`→CJS), then nearest
  `package.json` `"type":"module"` (now parsed with a real JSON parser, not a textual
  proximity heuristic), then a source heuristic.
- JSON modules.
- Best-effort CJS named-export discovery (textual `exports.<name>` scan) so
  `import { x } from "cjs-pkg"` binds; the default/namespace import always works.
- `node:` / `cloudflare:` / `workerd:` builtins are passed through (never shadowed).

The `exports`/`imports`/`type` logic is backed by a small self-contained JSON parser
(`JsonParser` in `vfs-module-fallback.c++`) so no JSON library is pulled into the TU.

## Files changed

| File | Change |
|------|--------|
| `src/workerd/server/vfs-module-fallback.h` / `.c++` | **New.** Node-style resolver against a `/tmp` `Directory`; returns redirect or capnp `Worker::Module`. Includes a self-contained JSON parser + conditional `exports`/`imports` map resolution (string/conditions/subpath/`*`-pattern) and JSON-parsed `type:module` detection. |
| `src/workerd/api/worker-loader.h` | `WorkerCode.vfsModuleFallback` opt-in field (+ `JSG_STRUCT`). |
| `src/workerd/api/worker-loader.c++` | Forward `code.vfsModuleFallback` into `DynamicWorkerSource`. |
| `src/workerd/io/io-channels.h` | `DynamicWorkerSource.vfsModuleFallback` field (+ `clone()`). |
| `src/workerd/server/server.c++` | `WorkerDef.vfsModuleFallback`; install the VFS fallback callback in `makeWorkerImpl` (legacy registry path), capturing the shared `/tmp` dir. |
| `src/workerd/server/BUILD.bazel` | Add `vfs-module-fallback.{c++,h}` to the `server` library. |
| `src/workerd/api/tests/worker-loader-vfs-module-test.{js,wd-test}` | **New** wd-test. |
| `src/workerd/api/tests/BUILD.bazel` | Register the new wd-test. |

## Validation

### STAGE 1 (+ core of STAGE 2) — self-contained wd-test

`src/workerd/api/tests/worker-loader-vfs-module-test.js` — 11/11 green. The parent writes
module sources into the shared `/tmp`; a child with `vfsModuleFallback:true` resolves and
runs them:

- `bareEsmFromNodeModules` — `import greet from "greet"` resolved via
  `/tmp/node_modules/greet` `package.json` `main`.
- `bareCjsFromNodeModules` — `require("adder")` (`module.exports = fn`) from `node_modules`.
- `relativeAndJson` — relative `import` chain + a JSON module, all under `/tmp`.
- `transitiveNodeModules` — a package that itself `require()`s a transitive dep.
- `exportsStringSugar` — `"exports": "./dist/main.js"` wins over a legacy `index.js`.
- `exportsConditions` — `import`→`./esm`, `require`→`./cjs`, **never** `browser`.
- `exportsSubpath` — `"./feature"` subpath resolves; a deep path **not** in `exports` is
  blocked.
- `exportsSubpathPattern` — `"./*": "./dist/*.js"` resolves `exppat/widget` →
  `dist/widget.js`.
- `importsHashMap` — `#internal` (condition target) and `#util/*` (pattern) resolve against
  the package's own `imports` map.
- `controlNoFallbackFails` — a child **without** the opt-in fails to import from `/tmp`.

```bash
cd /Users/netanelg/Development/workerd
bazelisk test '//src/workerd/api/tests:worker-loader-vfs-module-test@' --test_output=all
```

### STAGE 2 — real npm package, end-to-end in miniflare

`vite-workerd-demo/experiments/npm-in-workerd/vfs-child-mod/` — a DO installs the **real
left-pad@1.3.0** via Arborist into its native `/tmp/proj/node_modules`, then loads a child
that `require("left-pad")` (bare, node-resolved from `/tmp`) and returns `lp("x",5)`.

```bash
cd /Users/netanelg/Development/vite-workerd-demo/experiments/npm-in-workerd
MINIFLARE_WORKERD_PATH=/tmp/workerd-vfsmod-bin timeout 300 node vfs-child-mod/run.mjs
```

Observed output (PASS):

```
=== INSTALL left-pad (Arborist -> native /tmp) === HTTP 200
  { "ok": true, "installed": ["left-pad"] }
=== RUN CHILD (require('left-pad') from /tmp/node_modules) === HTTP 200
  { "ok": true, "cjsResult": "    x", "esmResult": "   y", "esmError": null }
VERDICT: PASS — child ran a real npm-installed package (left-pad) loaded entirely
                from the shared /tmp via CJS require AND ESM import
```

### STAGE 3 — real `vite@8` + `@vitejs/plugin-react`, module graph from `/tmp`

`vite-workerd-demo/experiments/npm-in-workerd/scratch-vite/` — a DO installs the **real
`vite@^8` + `@vitejs/plugin-react`** via Arborist into `/tmp/proj/node_modules`, then loads
a child (`shareParentTmp` + `vfsModuleFallback`) that does `await import("vite")`,
`await import("@vitejs/plugin-react")`, and `require("vite")` from the shared `/tmp`.

```bash
cd /Users/netanelg/Development/vite-workerd-demo/experiments/npm-in-workerd
MINIFLARE_WORKERD_PATH=/tmp/workerd-vfsmod-bin node scratch-vite/run.mjs
```

vite's `exports` is `{ ".": "./dist/node/index.js", "./client": {...}, "./*": ..., ... }`;
plugin-react is `{ "type": "module", "exports": { ".": "./dist/index.js" } }`. Both **fully
resolve** their module graphs from `/tmp` (string-sugar `.` export, `type:module` ESM
classification, transitive bare specifiers, conditional deps). Resolution no longer
produces any `No such module "<bare/relative>"` error. The first **execution-time** error
(the handoff to the execution task) is a missing Node builtin:

```
import("vite")               -> Error: No such module "node:readline".
                                imported from "tmp/proj/node_modules/vite/dist/node/chunks/logger.js"
import("@vitejs/plugin-react") -> Error: No such module "node:worker_threads".
                                imported from "tmp/proj/node_modules/rolldown/dist/shared/rolldown-build-*.mjs"
require("vite")              -> Error: No such module "node:readline". (same logger.js)
```

These are workerd builtins not implemented (`node:readline`, `node:worker_threads`), not
resolution failures — exactly the next-task boundary (execution: missing builtins,
`import.meta.url`, WASM compile, native bundler binaries).

## Binary

A built workerd with this feature: **`/tmp/workerd-vfsmod-bin`** (does not overwrite
`/tmp/workerd-fork-shared-bin`).

```bash
# Rebuild from source:
cd /Users/netanelg/Development/workerd
bazelisk build //src/workerd/server:workerd
cp bazel-bin/src/workerd/server/workerd /tmp/workerd-vfsmod-bin
```

## Limitations / notes

- **Same-thread only** (inherited from the shared-`/tmp` feature): the in-memory
  `Directory` is not thread-safe; safe in workerd because a loaded isolate runs on the
  parent's thread.
- **Legacy module registry path.** The callback is wired in the `!usingNewModuleRegistry`
  branch (the path dynamic workers use today, since they don't enable
  `new_module_registry`). The new module registry has a different fallback mechanism; if
  dynamic workers move to it, the callback wiring must be ported there too.
- **CJS named exports** are discovered by a conservative textual scan; missing one only
  means a *named* import won't bind (default/namespace import still works). For full
  fidelity a cjs-module-lexer-equivalent could be added later.
- **`package.json` `exports` / `imports`** are now implemented (see "Resolution semantics").
  Remaining gaps vs. full Node spec: no `node:`-target re-exports through the map (those
  pass straight through to native), no `engines`/platform-specific condition arrays beyond
  the common set, and `*` patterns expand greedily by longest prefix only.
- WASM/`.node` native addons are not served as modules (execution-task concern).
- **Resolution is "as far as the module graph"; execution is a separate task.** Resolving
  real `vite@8` from `/tmp` succeeds all the way through its graph and first fails at
  runtime on a missing Node builtin (`node:readline`) — see the vite stage below.
