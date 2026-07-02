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
// Scope (MVP): spawn() with captured (non-streaming) stdout/stderr delivered as 'data' events
// followed by 'exit'/'close' -- the contract @npmcli/promise-spawn and friends rely on. No
// signals/kill, no IPC, no stdin, no incremental output.

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

export class ChildProcess extends EventEmitter implements _ChildProcess {
  stdin: Writable | null = null;
  stdout: Readable | null = null;
  stderr: Readable | null = null;
  killed: boolean = false;
  pid: number | undefined = undefined;
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
// Pseudo-streams: enough Readable surface for consumers that do
// `child.stdout.on('data', ...)` (the ubiquitous pattern; @npmcli/promise-spawn included).
// Output is captured by the child and delivered as a single 'data' + 'end' after exit.

interface PseudoReadable extends EventEmitter {
  readable: boolean;
  pipe: (dest?: unknown) => unknown;
  setEncoding: (enc?: string) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  destroy: () => void;
}

function makeReadable(): PseudoReadable {
  const s = new EventEmitter() as PseudoReadable;
  s.readable = true;
  s.pipe = (dest?: unknown): unknown => dest ?? s;
  s.setEncoding = (): unknown => s;
  s.resume = (): unknown => s;
  s.pause = (): unknown => s;
  s.destroy = (): void => {};
  return s;
}

function makeWritable(): Writable {
  const s = new EventEmitter() as unknown as Record<string, unknown>;
  s.writable = true;
  s.write = (): boolean => true;
  s.end = (): void => {};
  s.destroy = (): void => {};
  return s as unknown as Writable;
}

// ---------------------------------------------------------------------------
// Command resolution over the shared /tmp VFS (node semantics, ported from the proven
// isolate-spawn bridge): tokenize `sh -c` lines, resolve bins via PATH and node_modules/.bin,
// special-case `node`.

function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (q) {
      if (ch === q) q = null;
      else if (q === '"' && ch === '\\' && i + 1 < line.length)
        cur += line.charAt(++i);
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line.charAt(++i);
      has = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (has || cur) {
        out.push(cur);
        cur = '';
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

function resolveArgv(file: string, args: string[]): string[] {
  const base = file.split('/').pop();
  if (
    (base === 'sh' || base === 'bash' || base === 'zsh') &&
    args[0] === '-c'
  ) {
    return tokenize(args[1] ?? '');
  }
  return [file, ...args];
}

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
  dir: string
): string {
  const OUT = JSON.stringify(`${dir}/out.log`);
  const ERR = JSON.stringify(`${dir}/err.log`);
  const STATUS = JSON.stringify(`${dir}/status.json`);
  return `
  import { WorkerEntrypoint } from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    async run() {
      const np = await import("node:process");
      const nfs = await import("node:fs");
      const mod = await import("node:module");
      const OUT = ${OUT}, ERR = ${ERR}, STATUS = ${STATUS};
      try { nfs.writeFileSync(OUT, ""); nfs.writeFileSync(ERR, ""); } catch {}
      const outw = (s) => { try { nfs.appendFileSync(OUT, typeof s === "string" ? s : String(s)); } catch {} return true; };
      const errw = (s) => { try { nfs.appendFileSync(ERR, typeof s === "string" ? s : String(s)); } catch {} return true; };
      const setStatus = (c) => { try { nfs.writeFileSync(STATUS, JSON.stringify({ code: c == null ? 0 : c })); } catch {} };
      // process.report.getReport() (libc probes) is not supported here; stub it.
      const reportStub = { excludeNetwork: true, getReport: () => ({ header: {}, sharedObjects: [] }) };
      for (const p of new Set([np.default, np, globalThis.process].filter(Boolean))) {
        try { p.argv = ${JSON.stringify(argv)}.slice(); } catch {}
        try { p.cwd = () => ${JSON.stringify(cwd)}; } catch { try { Object.defineProperty(p, "cwd", { configurable: true, value: () => ${JSON.stringify(cwd)} }); } catch {} }
        try { p.env = Object.assign(p.env || {}, ${JSON.stringify(envObj)}); } catch {}
        try { if (p.stdin) p.stdin.isTTY = false; } catch {}
        try { Object.defineProperty(p, "report", { configurable: true, value: reportStub }); } catch {}
        try { p.exit = (c) => { setStatus(c); const e = new Error("process.exit(" + c + ")"); e.__PROCESS_EXIT__ = true; throw e; }; } catch {}
      }
      try { np.default.stdout.write = outw; } catch {}
      try { np.default.stderr.write = errw; } catch {}
      const enc = (a) => a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ");
      console.log = (...a) => outw(enc(a) + "\\n");
      console.info = (...a) => outw(enc(a) + "\\n");
      console.warn = (...a) => errw(enc(a) + "\\n");
      console.error = (...a) => errw(enc(a) + "\\n");
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

let spawnCounter = 0;

interface NormalizedSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  shell: boolean | string;
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
  return { cwd, env, shell: options?.shell ?? false };
}

function readFileOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, 'utf8') as string;
  } catch {
    return fallback;
  }
}

async function runSpawn(
  child: ChildProcess,
  stdout: PseudoReadable,
  stderr: PseudoReadable,
  command: string,
  args: string[],
  options: NormalizedSpawnOptions
): Promise<void> {
  const finish = (code: number, errText?: string): void => {
    child.exitCode = code;
    if (errText) stderr.emit('data', Buffer.from(errText));
    stdout.emit('end');
    stderr.emit('end');
    child.emit('exit', code, null);
    child.emit('close', code, null);
  };

  const loader = childProcessUtil.getSpawnLoader();
  if (loader === undefined) {
    throw new ERR_METHOD_NOT_IMPLEMENTED(
      'child_process.spawn (this worker has no spawn capability: give it a ' +
        "workerLoader binding, or load it dynamically with 'allowSpawn: true')"
    );
  }

  // Resolve the command line to a JS entry on the VFS.
  let argv = [command, ...args];
  if (options.shell) {
    // `shell: true` semantics: the command line is a shell line; we support simple
    // whitespace/quote splitting (no operators, no expansions).
    argv = tokenize([command, ...args].join(' '));
  }
  argv = resolveArgv(argv[0] ?? '', argv.slice(1));

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

  // Materialize the probe under the shared /tmp and load the sub-isolate over it.
  const dir = `/tmp/.spawn-${++spawnCounter}-${Date.now().toString(36)}`;
  mkdirSync(dir, { recursive: true });
  const probePath = `${dir}/probe.mjs`;
  writeFileSync(
    probePath,
    probeSource(entry, childArgv, options.cwd, options.env, dir)
  );

  // waitpid bracket: while the child runs, the SPAWNER must not be considered quiescent by its
  // own drainProcess (the RPC await is invisible to the drain heuristic). Balanced in finally.
  childProcessUtil.spawnBegin();
  let rpcError: unknown = null;
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
    // waitpid: with drainProcess, this resolves when the child's event loop is quiescent.
    await stub.getEntrypoint().run();
  } catch (e) {
    rpcError = e;
  } finally {
    childProcessUtil.spawnEnd();
  }

  const out = readFileOr(`${dir}/out.log`, '');
  const err = readFileOr(`${dir}/err.log`, '');
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
    if (rpcError instanceof Error) throw rpcError;
    throw new Error(
      typeof rpcError === 'string' ? rpcError : JSON.stringify(rpcError)
    );
  }

  if (out) stdout.emit('data', Buffer.from(out));
  if (err) stderr.emit('data', Buffer.from(err));
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
  child.pid = ++spawnCounter;
  const stdout = makeReadable();
  const stderr = makeReadable();
  child.stdout = stdout as unknown as Readable;
  child.stderr = stderr as unknown as Readable;
  child.stdin = makeWritable();
  child.stdio = [child.stdin, child.stdout, child.stderr, null, null];

  // Listeners are attached synchronously after spawn() returns; runSpawn only emits after at
  // least one await, so emissions are always safely deferred.
  runSpawn(child, stdout, stderr, command, argsArr, normalized).catch(
    (e: unknown) => {
      child.emit('error', e);
    }
  );

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
};
