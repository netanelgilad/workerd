// Copyright (c) 2017-2022 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// FORK-ONLY (native-spawn): child_process.spawn() natively backed by a sub-isolate.
//
// In this fork there is no OS process model; instead, "spawning a process" means dynamically
// loading a sub-isolate that shares the spawner's /tmp virtual filesystem (shareParentTmp),
// resolves modules from it (vfsModuleFallback), and is run to event-loop quiescence
// (drainProcess) -- quiescence is the process exiting, and the parent's await is waitpid.
// The capability to create the sub-isolate comes from the C++ side
// (node-internal:child_process_util -> IoChannelFactory::getSpawnLoaderChannel()): a worker can
// spawn if it has a workerLoader binding or was itself loaded with `allowSpawn: true`. Spawned
// children are created with allowSpawn, so processes can spawn processes recursively.
//
// Scope: spawn() with REAL streaming stdio. child.stdin is a Writable whose bytes are delivered
// to the sub-isolate's process.stdin; child.stdout/child.stderr are Readables that emit chunks AS
// THE CHILD PRODUCES THEM (incremental), followed by 'end'/'exit'/'close'. stdio:"inherit"
// forwards the child's output to the parent's process.stdout/stderr. The streaming channel is a
// per-fd cross-isolate stream (TransformStream halves handed to the child over the loader RPC).
// No signals/kill, no IPC.

import type {
  SpawnSyncReturns,
  SpawnSyncOptions,
  SpawnOptions,
  ChildProcess as _ChildProcess,
  ExecOptions,
  ExecException,
  ExecFileOptions,
  ExecSyncOptions,
  ForkOptions,
} from 'node:child_process';
import { ERR_METHOD_NOT_IMPLEMENTED } from 'node-internal:internal_errors';
import { EventEmitter } from 'node-internal:events';
import { Buffer } from 'node-internal:internal_buffer';
import { Readable as NodeReadable } from 'node-internal:streams_readable';
import { Writable as NodeWritable } from 'node-internal:streams_writable';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node-internal:internal_fs_sync';
import { default as childProcessUtil } from 'node-internal:child_process_util';
import { env as processEnv } from 'node-internal:public_process';
import {
  validateFunction,
  validateObject,
  validateString,
  validateArray,
} from 'node-internal:validators';
// NodeReadable/NodeWritable (concrete classes, imported above) construct the stdio streams; the
// node:stream Readable/Writable types annotate the ChildProcess fields (base-type compatible).
import type { Readable, Writable } from 'node:stream';

// Compat environment for spawned "node processes". A spawned child is by definition a node-like
// program, so it gets a fixed node-flavored environment (rather than inheriting the spawner's
// exact flags, which the runtime does not currently expose by name).
const CHILD_COMPAT_DATE = '2026-06-01';
const CHILD_COMPAT_FLAGS = [
  'nodejs_compat',
  'nodejs_compat_v2',
  'experimental',
  'enable_nodejs_fs_module',
];

// ---------------------------------------------------------------------------
// FORK-ONLY (native-spawn observability, gap #2): pid/ppid + lifecycle events.
//
// Native spawn has no OS process model, so the runtime assigns its own pids (a process-global
// monotonic counter in C++; pid 1 is the root DO). A spawned child learns its own pid from
// process.pid (the probe injects it) and stamps it as its children's ppid, so ppid chains
// reconstruct the full pstree. spawn/exit events are appended to a process-global, append-only log
// (childProcessUtil.emitLifecycleEvent) that a consumer reads incrementally by cursor
// (readLifecycleEvents) -- exited processes stay observable.

// The current isolate's own pid: a spawned child's is injected onto process.pid by its parent's
// probe; the root DO keeps workerd's default process.pid (1), a stable root pid (Node's
// init-process convention). Cached: an isolate's pid is fixed for its lifetime.
let cachedMyPid: number | null = null;
function myPid(): number {
  if (cachedMyPid != null) return cachedMyPid;
  const injected = (globalThis as { process?: { pid?: number } }).process?.pid;
  cachedMyPid = typeof injected === 'number' && injected > 0 ? injected : 1;
  return cachedMyPid;
}

// Append a lifecycle event to the process-global bus. Best-effort: observability must never affect
// the spawn itself, and the append is synchronous (no pending I/O -> does not block quiescence).
function emitLifecycle(ev: Record<string, unknown>): void {
  try {
    childProcessUtil.emitLifecycleEvent(JSON.stringify(ev));
  } catch {
    // ignore -- observability is best-effort
  }
}

export class ChildProcess extends EventEmitter implements _ChildProcess {
  stdin: Writable | null = null;
  stdout: Readable | null = null;
  stderr: Readable | null = null;
  killed: boolean = false;
  pid: number | undefined = undefined;
  // FORK-ONLY (native-spawn observability, gap #2): the parent's pid. Node's ChildProcess has no
  // `ppid`, but native spawn has no OS process table, so we surface it here for observability
  // (the same value rides the emitted `spawn` lifecycle event).
  ppid: number | undefined = undefined;
  stdio: [
    Writable | null,
    Readable | null,
    Readable | null,
    Writable | Readable | null | undefined,
    Writable | Readable | null | undefined,
  ] = [null, null, null, null, null];
  connected: boolean = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  spawnargs: string[] = [];
  spawnfile: string = '';

  kill(_signal?: NodeJS.Signals | number): boolean {
    // There is no way to interrupt a sub-isolate "process" yet; report failure like a process
    // that could not be signaled.
    this.killed = true;
    return false;
  }

  send(
    _message: unknown,
    _sendHandle?: unknown,
    _options?: unknown,
    _callback?: unknown
  ): boolean {
    return false;
  }

  disconnect(): void {
    // Do nothing.
  }

  unref(): void {
    // Do nothing
  }

  ref(): void {
    // Do nothing
  }

  [Symbol.dispose](): void {
    this.kill();
  }
}

// ---------------------------------------------------------------------------
// Real streaming stdio over a per-fd cross-isolate stream.
//
// Each spawn allocates three TransformStreams whose halves straddle the isolate boundary
// over the loader RPC:
//   - stdin:  parent writes child.stdin (a Writable) -> transform.writable -> transform.readable is
//             handed to the child, which reads it into its process.stdin.
//   - stdout/stderr: the child writes the transform.writable it was handed -> transform.readable is
//             pumped by the PARENT, which either pushes chunks into child.stdout/child.stderr
//             (a Readable, 'pipe' mode -> incremental 'data'), forwards them to the parent's
//             process.stdout/stderr ('inherit'), or discards them ('ignore').
//
// The child never closes its stdout/stderr writables (with drainProcess the child does not know
// when the "process" has exited -- the parent's runToQuiescence decides). Instead the parent, once
// `run()` resolves (waitpid = quiescence), grants a short grace for trailing chunks to land, then
// cancels the reader and ends the Readable. All the child's stream writes are counted by
// pendingDrainIoCount, so quiescence is not declared until every written chunk has flushed across
// the boundary -- no lost output.

type StdioMode = 'pipe' | 'inherit' | 'ignore';

// The parent-side plumbing for one spawned child's three stdio fds.
interface StdioChannels {
  // Halves handed to the child over RPC.
  childStdin: ReadableStream;
  childStdout: WritableStream;
  childStderr: WritableStream;
  // Parent-side ends.
  stdinWriter: WritableStreamDefaultWriter | null; // null when stdin is not 'pipe'
  stdoutReadable: ReadableStream;
  stderrReadable: ReadableStream;
  modes: { stdin: StdioMode; stdout: StdioMode; stderr: StdioMode };
}

// A push-based Readable used for child.stdout/child.stderr in 'pipe' mode: the parent pump pushes
// chunks as they arrive, then push(null) at child exit.
function makePushReadable(): Readable {
  return new NodeReadable({
    read(): void {
      // Data is delivered by push() from the parent pump; nothing to pull on demand.
    },
  }) as unknown as Readable;
}

// Build the three transform streams + the parent/child ends given the resolved stdio modes.
function makeStdioChannels(modes: {
  stdin: StdioMode;
  stdout: StdioMode;
  stderr: StdioMode;
}): StdioChannels {
  // A default TransformStream is an identity (passthrough) transform; its readable/writable halves
  // are standard streams that serialize across the isolate boundary over the loader RPC.
  const stdinTs = new TransformStream();
  const stdoutTs = new TransformStream();
  const stderrTs = new TransformStream();

  let stdinWriter: WritableStreamDefaultWriter | null = null;
  const childStdin: ReadableStream = stdinTs.readable;

  if (modes.stdin === 'pipe') {
    stdinWriter = stdinTs.writable.getWriter();
  } else if (modes.stdin === 'inherit') {
    // Forward the parent's process.stdin into the child. Best-effort: if the parent has no
    // readable stdin we simply leave the pipe open (empty), matching an inherited-but-idle stdin.
    stdinWriter = stdinTs.writable.getWriter();
    pumpParentStdinInto(stdinWriter);
  } else {
    // 'ignore': the child sees an immediately-closed stdin (EOF).
    stdinTs.writable.getWriter().close().catch(() => {});
  }

  return {
    childStdin,
    childStdout: stdoutTs.writable,
    childStderr: stderrTs.writable,
    stdinWriter,
    stdoutReadable: stdoutTs.readable,
    stderrReadable: stderrTs.readable,
    modes,
  };
}

// child.stdin: a real Writable whose bytes feed the stdin transform (and whose write callbacks are
// honored -- Node's Writable contract). null when stdin mode is not 'pipe'.
function makeStdinWritable(writer: WritableStreamDefaultWriter): Writable {
  return new NodeWritable({
    write(chunk: unknown, _enc: unknown, cb: (err?: Error | null) => void): void {
      const bytes =
        typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : (chunk as Uint8Array);
      writer.write(bytes).then(
        () => cb(),
        (e: unknown) => cb(e as Error)
      );
    },
    final(cb: (err?: Error | null) => void): void {
      writer.close().then(
        () => cb(),
        () => cb()
      );
    },
  }) as unknown as Writable;
}

// stdio:"inherit" for stdin: pump the parent's process.stdin (a Node Readable, when present) into
// the child's stdin writer.
function pumpParentStdinInto(writer: WritableStreamDefaultWriter): void {
  const p = (globalThis as { process?: { stdin?: unknown } }).process;
  const stdin = p?.stdin as
    | (EventEmitter & { resume?: () => void })
    | undefined;
  if (stdin == null || typeof stdin.on !== 'function') {
    writer.close().catch(() => {});
    return;
  }
  stdin.on('data', (chunk: unknown) => {
    const bytes =
      typeof chunk === 'string'
        ? new TextEncoder().encode(chunk)
        : (chunk as Uint8Array);
    writer.write(bytes).catch(() => {});
  });
  stdin.on('end', () => {
    writer.close().catch(() => {});
  });
  stdin.resume?.();
}

// Write a chunk to the parent's process.stdout/stderr (stdio:"inherit" forwarding). In a spawned
// parent this hits the parent's own patched write, so output chains up to the ancestor.
function writeToParent(which: 'stdout' | 'stderr', chunk: Uint8Array): void {
  const p = (
    globalThis as {
      process?: { stdout?: { write?: (c: unknown) => void }; stderr?: { write?: (c: unknown) => void } };
    }
  ).process;
  const stream = which === 'stdout' ? p?.stdout : p?.stderr;
  try {
    stream?.write?.(Buffer.from(chunk));
  } catch {
    // best-effort forwarding
  }
}

// ---------------------------------------------------------------------------
// Command resolution over the shared /tmp VFS (node semantics): execvp-style PATH resolution of
// the program name to a JS entry, resolving bins via PATH and node_modules/.bin, special-casing
// `node`. Shell mode is NOT handled here -- a shell is an ordinary program, so `sh -c '<line>'`
// (and `shell:true`, which synthesizes it) resolves the real `sh` binary via PATH like any other
// program and hands it the line UNMODIFIED; the runtime never tokenizes/interprets shell syntax
// itself. See runSpawn for where shell mode is turned into `sh -c <line>`.

function realOrSelf(p: string): string {
  try {
    return realpathSync(p) as string;
  } catch {
    return p;
  }
}

// Scan a node_modules dir for a package whose "bin" provides `cmd` (used when PATH points at a
// node_modules/.bin that npm did not physically populate on the VFS).
function scanNmForBin(nm: string, cmd: string): string | null {
  let names: string[];
  try {
    names = readdirSync(nm) as string[];
  } catch {
    return null;
  }
  const dirs: string[] = [];
  for (const n of names) {
    if (n.startsWith('@')) {
      try {
        for (const s of readdirSync(`${nm}/${n}`) as string[]) {
          dirs.push(`${n}/${s}`);
        }
      } catch {
        // ignore
      }
    } else {
      dirs.push(n);
    }
  }
  for (const d of dirs) {
    let pkg: { name?: string; bin?: string | Record<string, string> };
    try {
      pkg = JSON.parse(
        readFileSync(`${nm}/${d}/package.json`, 'utf8') as string
      ) as typeof pkg;
    } catch {
      continue;
    }
    const bin = pkg.bin;
    const short = (pkg.name ?? '').split('/').pop();
    if (typeof bin === 'string' && (pkg.name === cmd || short === cmd)) {
      return `${nm}/${d}/${bin.replace(/^\.\//, '')}`;
    }
    if (bin && typeof bin === 'object' && bin[cmd]) {
      return `${nm}/${d}/${bin[cmd].replace(/^\.\//, '')}`;
    }
  }
  return null;
}

function resolveBinToJs(cmd: string, path: string): string | null {
  if (cmd.startsWith('/') && existsSync(cmd)) return realOrSelf(cmd);
  const dirs = path.split(':').filter(Boolean);
  for (const dir of dirs) {
    const cand = `${dir}/${cmd}`;
    try {
      if (existsSync(cand)) return realOrSelf(cand);
    } catch {
      // ignore
    }
  }
  for (const dir of dirs) {
    if (dir.endsWith('/.bin')) {
      const hit = scanNmForBin(dir.slice(0, -5), cmd);
      if (hit) return hit;
    }
  }
  return null;
}

function resolvePathLike(cwd: string, p: string): string {
  if (p.startsWith('/')) return p;
  return `${cwd.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`;
}

// workerd's loader rejects a leading shebang; require() a stripped sibling copy instead.
function stripShebang(entry: string): string {
  try {
    const head = readFileSync(entry, 'utf8') as string;
    if (head.startsWith('#!')) {
      const s = entry.lastIndexOf('/');
      const stripped = `${entry.slice(0, s + 1)}__nosheb_${entry.slice(s + 1)}`;
      writeFileSync(stripped, head.replace(/^#![^\n]*\n/, '//\n'));
      return stripped;
    }
  } catch {
    // unreadable entry: let the child's require() produce the error
  }
  return entry;
}

// ---------------------------------------------------------------------------
// The process probe: the synthesized main of the spawned sub-isolate. It sets argv/cwd/env,
// redirects stdout/stderr/console into VFS log files, records process.exit()'s code in a status
// file, then require()s the bin FIRE-AND-FORGET. drainProcess then runs the child's event loop
// to quiescence before the parent's run() RPC resolves -- that resolution is process exit.

function probeSource(
  entry: string,
  argv: string[],
  cwd: string,
  envObj: Record<string, string>,
  dir: string,
  pid: number,
  ppid: number
): string {
  const STATUS = JSON.stringify(`${dir}/status.json`);
  // run(stdinReadable, stdoutWritable, stderrWritable): the three stdio halves are handed in over
  // the loader RPC. stdout/stderr are written as raw bytes AS PRODUCED (incremental); process.stdin
  // is a lazy Readable that only starts pulling from the RPC stream when the child actually consumes
  // it -- so a child that never touches stdin still reaches quiescence (a child actively reading
  // stdin holds a pending read, keeping the "process" alive until EOF, exactly like Node). The exit
  // code is recorded in status.json (read by the parent after waitpid).
  return `
  import { WorkerEntrypoint } from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    async run(stdinReadable, stdoutWritable, stderrWritable) {
      const np = await import("node:process");
      const nfs = await import("node:fs");
      const mod = await import("node:module");
      const { Readable } = await import("node:stream");
      const STATUS = ${STATUS};
      const enc = new TextEncoder();
      const sow = stdoutWritable.getWriter();
      const sew = stderrWritable.getWriter();
      // Raw byte streaming to the parent; honor write(chunk, [enc], cb) (npm's exit-handler flushes
      // through the callback chain -- without invoking cb it never reaches its real process.exit()).
      const mkWrite = (w) => (s, e2, cb) => {
        try { w.write(typeof s === "string" ? enc.encode(s) : s).catch(() => {}); } catch {}
        const f = typeof e2 === "function" ? e2 : cb;
        if (typeof f === "function") queueMicrotask(() => { try { f(); } catch {} });
        return true;
      };
      const outw = mkWrite(sow);
      const errw = mkWrite(sew);
      const setStatus = (c) => { try { nfs.writeFileSync(STATUS, JSON.stringify({ code: c == null ? 0 : c })); } catch {} };
      // Lazy process.stdin: pulls one chunk from the RPC stream per _read() (i.e. only when the
      // child consumes it). No consumer -> no pending read -> quiescence; a consumer -> a pending
      // read that keeps the process alive until EOF.
      let stdinReader = null, stdinDone = false;
      const nodeStdin = new Readable({
        read() {
          if (stdinDone) { this.push(null); return; }
          if (stdinReader == null) {
            if (stdinReadable == null) { stdinDone = true; this.push(null); return; }
            stdinReader = stdinReadable.getReader();
          }
          stdinReader.read().then(({ value, done }) => {
            if (done) { stdinDone = true; this.push(null); }
            else this.push(Buffer.from(value));
          }, () => { stdinDone = true; this.push(null); });
        }
      });
      nodeStdin.isTTY = false;
      // process.report.getReport() (libc probes) is not supported here; stub it.
      const reportStub = { excludeNetwork: true, getReport: () => ({ header: {}, sharedObjects: [] }) };
      let exitCodeShadow = null; // mirrors process.exitCode (node's implicit exit code)
      for (const p of new Set([np.default, np, globalThis.process].filter(Boolean))) {
        try { p.argv = ${JSON.stringify(argv)}.slice(); } catch {}
        // pid/ppid: this child's OWN pid (so its own child_process reads it as ppid for grandchildren)
        // and its parent's pid. Node-faithful (process.pid/process.ppid) and drives the pstree.
        try { Object.defineProperty(p, "pid", { configurable: true, value: ${pid} }); } catch { try { p.pid = ${pid}; } catch {} }
        try { Object.defineProperty(p, "ppid", { configurable: true, value: ${ppid} }); } catch { try { p.ppid = ${ppid}; } catch {} }
        try { p.cwd = () => ${JSON.stringify(cwd)}; } catch { try { Object.defineProperty(p, "cwd", { configurable: true, value: () => ${JSON.stringify(cwd)} }); } catch {} }
        try { p.env = Object.assign(p.env || {}, ${JSON.stringify(envObj)}); } catch {}
        try { Object.defineProperty(p, "stdin", { configurable: true, get: () => nodeStdin }); } catch {}
        try { Object.defineProperty(p, "report", { configurable: true, value: reportStub }); } catch {}
        try { Object.defineProperty(p, "exitCode", { configurable: true, get: () => exitCodeShadow, set: (v) => { exitCodeShadow = v; } }); } catch {}
        // process.exit(): record status (no arg -> process.exitCode), then throw to unwind.
        try { p.exit = (c) => { const v = c == null ? (exitCodeShadow == null ? 0 : exitCodeShadow) : c; setStatus(v); const e = new Error("process.exit(" + v + ")"); e.__PROCESS_EXIT__ = true; throw e; }; } catch {}
      }
      try { np.default.stdout.write = outw; } catch {}
      try { np.default.stderr.write = errw; } catch {}
      const encA = (a) => a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ");
      console.log = (...a) => outw(encA(a) + "\\n");
      console.info = (...a) => outw(encA(a) + "\\n");
      console.warn = (...a) => errw(encA(a) + "\\n");
      console.error = (...a) => errw(encA(a) + "\\n");
      // require() is synchronous and stays in-context; a dynamic import()'s microtask checkpoint
      // would drop the IoContext (-> "global scope" error). Fire-and-forget: drainProcess owns
      // the rest of the process lifetime.
      const require = mod.createRequire(${JSON.stringify(cwd + '/__spawn__.js')});
      try { require(${JSON.stringify(entry)}); }
      catch (e) {
        if (!(e && e.__PROCESS_EXIT__)) {
          errw("[spawn] " + (e && e.stack || e) + "\\n");
          setStatus(1);
        }
      }
      return { started: true };
    }
  }`;
}

interface NormalizedSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  shell: boolean | string;
  stdio: { stdin: StdioMode; stdout: StdioMode; stderr: StdioMode };
}

// Node's stdio option -> per-fd mode. Accepts the string shorthands ('pipe'|'inherit'|'ignore'),
// an array of three, or defaults to 'pipe'. Unsupported per-fd values (Stream/fd/'ipc') fall back
// to 'pipe' (the streaming channel is always allocated).
function normalizeStdio(stdio: unknown): {
  stdin: StdioMode;
  stdout: StdioMode;
  stderr: StdioMode;
} {
  const one = (v: unknown): StdioMode =>
    v === 'inherit' || v === 'ignore' ? v : 'pipe';
  if (typeof stdio === 'string') {
    const m = one(stdio);
    return { stdin: m, stdout: m, stderr: m };
  }
  if (Array.isArray(stdio)) {
    return {
      stdin: one(stdio[0]),
      stdout: one(stdio[1]),
      stderr: one(stdio[2]),
    };
  }
  return { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' };
}

function normalizeSpawnOptions(
  options: SpawnOptions | undefined | null
): NormalizedSpawnOptions {
  const cwdOpt = options?.cwd;
  const cwd =
    cwdOpt == null
      ? '/tmp'
      : typeof cwdOpt === 'string'
        ? cwdOpt
        : cwdOpt.pathname;
  let env: Record<string, string>;
  if (options?.env != null) {
    env = {};
    for (const [k, v] of Object.entries(options.env)) {
      if (v != null) env[k] = v;
    }
  } else {
    env = { ...(processEnv as Record<string, string>) };
  }
  return {
    cwd,
    env,
    shell: options?.shell ?? false,
    stdio: normalizeStdio(options?.stdio),
  };
}

function readFileOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, 'utf8') as string;
  } catch {
    return fallback;
  }
}

// Pump a stdout/stderr readable half from the child, delivering chunks LIVE. Returns a handle to
// finalize (grace + cancel) once the child has exited, since the child never closes its writable.
function pumpChildOutput(
  readable: ReadableStream,
  which: 'stdout' | 'stderr',
  mode: StdioMode,
  target: Readable | null
): { done: Promise<void>; finalize: () => Promise<void> } {
  const reader = readable.getReader();
  let stopped = false;
  const loop = (async (): Promise<void> => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value == null) continue;
        const bytes = value as Uint8Array;
        if (mode === 'inherit') writeToParent(which, bytes);
        else if (mode === 'pipe' && target) target.push(Buffer.from(bytes));
        // 'ignore': drained and discarded.
      }
    } catch {
      // reader cancelled / stream errored -- treated as end-of-output.
    }
  })();
  const finalize = async (): Promise<void> => {
    // The child never closes its writable (drainProcess decides exit). All writes have flushed by
    // quiescence; grant a short grace for the final chunk's reader.read() microtask to land, then
    // release the reader and let the loop finish.
    await new Promise((r) => setTimeout(r, 20));
    stopped = true;
    try {
      await reader.cancel();
    } catch {
      // already released
    }
    await loop;
  };
  return { done: loop, finalize };
}

async function runSpawn(
  child: ChildProcess,
  io: StdioChannels,
  command: string,
  args: string[],
  options: NormalizedSpawnOptions
): Promise<void> {
  const stdoutTarget = child.stdout as Readable | null;
  const stderrTarget = child.stderr as Readable | null;

  // End the readables + emit exit/close (Node order: 'exit' then 'close'). errText is surfaced on
  // stderr (or the parent's stderr under 'inherit') for early resolution failures.
  const finish = (code: number, errText?: string): void => {
    child.exitCode = code;
    if (errText) {
      const bytes = new TextEncoder().encode(errText);
      if (io.modes.stderr === 'inherit') writeToParent('stderr', bytes);
      else if (stderrTarget) stderrTarget.push(Buffer.from(bytes));
    }
    if (stdoutTarget) stdoutTarget.push(null);
    if (stderrTarget) stderrTarget.push(null);
    io.stdinWriter?.close().catch(() => {});
    // Lifecycle: the child (pid) has exited. Emitted before 'exit'/'close' so the event stream
    // records the exit even if a listener throws. Exited processes stay observable in the log.
    emitLifecycle({ type: 'exit', pid: child.pid, code });
    child.emit('exit', code, null);
    child.emit('close', code, null);
  };

  // Defer every emission past a microtask so synchronously-attached listeners (promise-spawn et al.)
  // are always registered before 'error'/'exit'/'close'/'data' fire, including on the early
  // resolution-failure paths below (gap: early-failure events must not fire synchronously).
  await Promise.resolve();

  const loader = childProcessUtil.getSpawnLoader();
  if (loader === undefined) {
    throw new ERR_METHOD_NOT_IMPLEMENTED(
      'child_process.spawn (this worker has no spawn capability: give it a ' +
        "workerLoader binding, or load it dynamically with 'allowSpawn: true')"
    );
  }

  // Resolve the command line to a JS entry on the VFS. Shell mode delegates to a REAL `sh`
  // resolved via PATH: the runtime never tokenizes or interprets the line -- a shell is an
  // ordinary program, not a runtime feature. `shell:true` synthesizes `sh -c <line>` exactly like
  // Node's POSIX path (joining command + args with spaces); `options.shell` as a string names the
  // shell binary (still PATH-resolved). An EXPLICIT `sh -c '<line>'` needs no special-casing here
  // -- it flows through unchanged so the child's `sh` binary parses the line and PATH-resolves the
  // inner commands (recursively spawning them). If no `sh` is on PATH, resolution below fails
  // ENOENT-style (exit 127), exactly like a real OS; there is deliberately no builtin fallback.
  let argv: string[];
  if (options.shell) {
    const shellName = typeof options.shell === 'string' ? options.shell : 'sh';
    argv = [shellName, '-c', [command, ...args].join(' ')];
  } else {
    argv = [command, ...args];
  }

  const file = argv[0] ?? '';
  const base = file.split('/').pop();
  let entry: string | null;
  let childArgs: string[];
  if (base === 'node' || base === 'nodejs') {
    // `node <script> ...` -- the script IS the entry.
    const script = argv[1];
    if (script === undefined) {
      finish(9, 'spawn: node REPL is not supported in this environment\n');
      return;
    }
    entry = resolvePathLike(options.cwd, script);
    if (!existsSync(entry)) {
      finish(127, `spawn: cannot find module '${entry}'\n`);
      return;
    }
    childArgs = argv.slice(2);
  } else {
    const path =
      options.env['PATH'] ??
      (processEnv as Record<string, string | undefined>)['PATH'] ??
      '/usr/bin:/bin';
    entry = resolveBinToJs(file, path);
    if (entry == null) {
      finish(127, `spawn: cannot resolve '${file}' (PATH=${path})\n`);
      return;
    }
    childArgs = argv.slice(1);
  }

  entry = stripShebang(entry);
  const childArgv = ['node', entry, ...childArgs];

  // pid (globally-unique, already assigned on the handle) + ppid (this spawner's own pid). The
  // child's probe injects pid onto its process.pid, so when the child spawns a grandchild it stamps
  // this pid as the grandchild's ppid -- the ppid chain that reconstructs the pstree.
  const pid = child.pid ?? 0;
  const ppid = myPid();

  // Materialize the probe under the shared /tmp and load the sub-isolate over it. The dir is keyed
  // by the globally-unique pid so concurrent spawns from different isolates (which share /tmp) never
  // collide.
  const dir = `/tmp/.spawn-${pid}`;
  mkdirSync(dir, { recursive: true });
  const probePath = `${dir}/probe.mjs`;
  writeFileSync(
    probePath,
    probeSource(entry, childArgv, options.cwd, options.env, dir, pid, ppid)
  );

  // waitpid bracket: while the child runs, the SPAWNER must not be considered quiescent by its
  // own drainProcess (the RPC await is invisible to the drain heuristic). Balanced in finally.
  childProcessUtil.spawnBegin();
  let rpcError: unknown = null;
  // Start pumping the child's stdout/stderr LIVE (chunks emit as the child produces them). These
  // read-loops run concurrently with the run() RPC; the reads are counted by pendingDrainIoCount,
  // so a spawner-that-is-itself-a-drainProcess-child stays alive while collecting child output.
  const outPump = pumpChildOutput(
    io.stdoutReadable,
    'stdout',
    io.modes.stdout,
    stdoutTarget
  );
  const errPump = pumpChildOutput(
    io.stderrReadable,
    'stderr',
    io.modes.stderr,
    stderrTarget
  );
  try {
    const stub = loader.load({
      compatibilityDate: CHILD_COMPAT_DATE,
      compatibilityFlags: CHILD_COMPAT_FLAGS,
      allowExperimental: true,
      shareParentTmp: true,
      vfsModuleFallback: true,
      drainProcess: true,
      allowSpawn: true,
      mainModule: 'main.js',
      modules: {
        'main.js': `export { default } from ${JSON.stringify(probePath)};`,
      },
    });
    // waitpid: with drainProcess, this resolves when the child's event loop is quiescent. The three
    // stdio halves are handed in as RPC arguments (the RPC proxy is dynamically typed).
    const entry = stub.getEntrypoint() as unknown as {
      run: (...a: unknown[]) => Promise<unknown>;
    };
    await entry.run(io.childStdin, io.childStdout, io.childStderr);
  } catch (e) {
    rpcError = e;
  } finally {
    childProcessUtil.spawnEnd();
  }

  // Child has exited (or the RPC failed). Finalize the output pumps: grace for trailing chunks,
  // then release the readers (the child never closes its writables).
  await Promise.all([outPump.finalize(), errPump.finalize()]);

  let code: number | null = null;
  try {
    const status = JSON.parse(readFileOr(`${dir}/status.json`, '')) as {
      code?: number;
    };
    if (typeof status.code === 'number') code = status.code;
  } catch {
    // no explicit exit recorded
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }

  if (rpcError != null && code === null) {
    // The child isolate failed outright without recording an exit; surface as 'error'.
    if (stdoutTarget) stdoutTarget.push(null);
    if (stderrTarget) stderrTarget.push(null);
    io.stdinWriter?.close().catch(() => {});
    if (rpcError instanceof Error) throw rpcError;
    throw new Error(
      typeof rpcError === 'string' ? rpcError : JSON.stringify(rpcError)
    );
  }

  finish(code ?? 0);
}

export function _forkChild(_fd: number, _serializationMode: number): void {
  throw new ERR_METHOD_NOT_IMPLEMENTED('child_process._forkChild');
}

export function exec(
  command: string,
  options: ExecOptions | undefined | null,
  callback?: (
    error: ExecException | null,
    stdout: string | Buffer,
    stderr: string | Buffer
  ) => void
): ChildProcess {
  validateString(command, 'command');
  if (options != null) {
    validateObject(options, 'options');
  }
  if (callback != null) {
    validateFunction(callback, 'callback');
  }
  throw new ERR_METHOD_NOT_IMPLEMENTED('child_process.exec');
}

export function execFile(
  _file: string,
  _args: string[],
  _options?: ExecFileOptions | null,
  _callback?: (
    error?: Error,
    stdout?: string | Buffer,
    stderr?: string | Buffer
  ) => unknown
): void {
  throw new ERR_METHOD_NOT_IMPLEMENTED('child_process.execFile');
}

export function execFileSync(
  _file: string,
  _args: string[] | ExecFileOptions | null,
  _options?: ExecFileOptions | null
): void {
  throw new ERR_METHOD_NOT_IMPLEMENTED('child_process.execFileSync');
}

export function execSync(
  _command: string,
  _options?: ExecSyncOptions | null
): Buffer | string {
  throw new ERR_METHOD_NOT_IMPLEMENTED('child_process.execSync');
}

export function fork(
  _modulePath: string | URL,
  args: readonly string[] | ForkOptions | null,
  options?: ForkOptions | null
): ChildProcess {
  if (args == null) {
    args = [];
  } else if (typeof args === 'object' && !Array.isArray(args)) {
    // @ts-expect-error TS2322 This is intentional.
    options = args;
    args = [];
  } else {
    validateArray(args, 'args');
  }

  if (options != null) {
    validateObject(options, 'options');
  }

  throw new ERR_METHOD_NOT_IMPLEMENTED('child_process.fork');
}

export function spawn(
  command: string,
  args?: readonly string[] | SpawnOptions | null,
  options?: SpawnOptions | null
): ChildProcess {
  validateString(command, 'command');
  if (args == null) {
    args = [];
  } else if (typeof args === 'object' && !Array.isArray(args)) {
    options = args as SpawnOptions;
    args = [];
  } else {
    validateArray(args, 'args');
  }
  if (options != null) {
    validateObject(options, 'options');
  }

  const argsArr = (args as readonly string[]).map(String);
  const normalized = normalizeSpawnOptions(options);

  const child = new ChildProcess();
  child.spawnfile = command;
  child.spawnargs = [command, ...argsArr];
  // Globally-unique, monotonic pid from the C++ bus (pid 1 is the root DO). ppid is this spawner's
  // own pid. Emit the `spawn` lifecycle event now (synchronous, non-blocking append) so the event
  // stream records the spawn with its pid/ppid/argv even for a child that exits immediately.
  child.pid = childProcessUtil.nextPid();
  child.ppid = myPid();
  emitLifecycle({
    type: 'spawn',
    pid: child.pid,
    ppid: child.ppid,
    argv: child.spawnargs,
  });

  const io = makeStdioChannels(normalized.stdio);
  // Node semantics: child.std{out,err} are Readables only in 'pipe' mode (null under
  // inherit/ignore); child.stdin is a Writable only in 'pipe' mode.
  child.stdin =
    normalized.stdio.stdin === 'pipe' && io.stdinWriter
      ? makeStdinWritable(io.stdinWriter)
      : null;
  child.stdout = normalized.stdio.stdout === 'pipe' ? makePushReadable() : null;
  child.stderr = normalized.stdio.stderr === 'pipe' ? makePushReadable() : null;
  child.stdio = [child.stdin, child.stdout, child.stderr, null, null];

  // Listeners are attached synchronously after spawn() returns; runSpawn awaits a microtask before
  // any emission, so 'error'/'exit'/'close'/'data' are always safely deferred past listener setup.
  runSpawn(child, io, command, argsArr, normalized).catch((e: unknown) => {
    child.emit('error', e);
  });

  return child;
}

export function spawnSync(
  command: string,
  _args?: readonly string[] | SpawnSyncOptions,
  _options?: SpawnSyncOptions
): SpawnSyncReturns<string | Buffer> {
  validateString(command, 'command');
  throw new ERR_METHOD_NOT_IMPLEMENTED('child_process.spawnSync');
}

// FORK-ONLY (native-spawn observability, gap #2): one native-spawn lifecycle event.
export interface ProcessLifecycleEvent {
  type: 'spawn' | 'exit';
  pid: number | undefined;
  ppid?: number; // spawn only
  argv?: string[]; // spawn only
  code?: number | null; // exit only
}

// FORK-ONLY (native-spawn observability, gap #2): read the process-global spawn lifecycle event
// stream. Returns the events (spawn/exit, in order) appended at or after `cursor`, plus the next
// cursor to pass on the following call. This is an append-only STREAM, not a live snapshot table:
// exited processes remain in it, so a consumer reconstructs BOTH a live pstree (a `spawn` with no
// matching `exit`) and an exited-history view. A consumer scopes to its own subtree by following
// ppid links from its own pid (the root DO's pid is 1).
export function readProcessEvents(cursor: number = 0): {
  events: ProcessLifecycleEvent[];
  cursor: number;
} {
  const raw = childProcessUtil.readLifecycleEvents(cursor);
  const events: ProcessLifecycleEvent[] = [];
  for (const s of raw) {
    try {
      events.push(JSON.parse(s) as ProcessLifecycleEvent);
    } catch {
      // skip a malformed record
    }
  }
  return { events, cursor: cursor + raw.length };
}

export default {
  ChildProcess,
  _forkChild,
  exec,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
  readProcessEvents,
};
