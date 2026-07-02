// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// FORK-ONLY (native-spawn streaming stdio): exercises the REAL streaming stdio of native
// child_process.spawn -- incremental stdout, stdin delivery, stdio:"inherit" forwarding,
// child-side write-callback fidelity, and deferred early-failure events. This worker has a
// `workerLoader` binding, which grants it native-spawn capability (server.c++: a config worker
// with >=1 workerLoader binding gets a spawn loader channel), so spawn() actually launches
// sub-isolate "processes" here (unlike child_process-nodejs-test.js, which has no capability and
// asserts the ERR_METHOD_NOT_IMPLEMENTED path).

import { ok, strictEqual } from 'node:assert';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

function writeScript(name, src) {
  mkdirSync('/tmp', { recursive: true });
  const path = `/tmp/${name}`;
  writeFileSync(path, src);
  return path;
}

function collect(stream) {
  const chunks = [];
  stream.on('data', (c) => chunks.push(Buffer.from(c)));
  return () => Buffer.concat(chunks).toString('utf8');
}

// (a) A child that emits stdout OVER TIME is received incrementally by the parent: the first chunk
// must arrive well before the child exits (with the old buffered behavior both chunks + exit landed
// together, so the first-data->exit delta would be ~0).
export const incrementalStdout = {
  async test() {
    const script = writeScript(
      'stdio_incremental.js',
      `process.stdout.write("first\\n");
       setTimeout(() => { process.stdout.write("second\\n"); process.exit(0); }, 200);`
    );
    const child = spawn('node', [script]);
    let firstDataAt = null;
    let exitAt = null;
    const readOut = collect(child.stdout);
    child.stdout.on('data', () => {
      if (firstDataAt == null) firstDataAt = Date.now();
    });
    const code = await new Promise((resolve) => {
      child.on('exit', (c) => {
        exitAt = Date.now();
        resolve(c);
      });
    });
    strictEqual(code, 0);
    const out = readOut();
    ok(out.includes('first'), `stdout should contain "first": ${JSON.stringify(out)}`);
    ok(out.includes('second'), `stdout should contain "second": ${JSON.stringify(out)}`);
    ok(firstDataAt != null, 'a data event must fire');
    // Incremental: the first chunk arrived clearly before exit (child slept 200ms between chunks).
    ok(
      exitAt - firstDataAt >= 80,
      `first chunk must arrive incrementally, not batched at exit (delta=${exitAt - firstDataAt}ms)`
    );
  },
};

// (b) A child reads from process.stdin and echoes it back on stdout. Proves child.stdin (parent
// Writable) -> child process.stdin delivery, and EOF propagation (child.stdin.end() -> 'end').
export const stdinEcho = {
  async test() {
    const script = writeScript(
      'stdio_echo.js',
      `let buf = "";
       process.stdin.setEncoding && process.stdin.setEncoding("utf8");
       process.stdin.on("data", (d) => { buf += d.toString(); });
       process.stdin.on("end", () => { process.stdout.write("ECHO:" + buf); process.exit(0); });`
    );
    const child = spawn('node', [script]);
    const readOut = collect(child.stdout);
    child.stdin.write('hello stdin');
    child.stdin.end();
    const code = await new Promise((resolve) => child.on('exit', resolve));
    strictEqual(code, 0);
    const out = readOut();
    ok(
      out.includes('ECHO:hello stdin'),
      `child must echo its stdin: ${JSON.stringify(out)}`
    );
  },
};

// (b2) drainProcess quiescence stays correct with streaming stdin in flight: a child actively
// reading stdin must NOT be declared quiescent while its stdin is still open (a pending read keeps
// the "process" alive, exactly like Node). The parent writes one chunk, PAUSES 150ms, then writes
// a second chunk and closes -- if quiescence were declared during the pause the child would exit
// early and lose "part2".
export const stdinKeepsChildAlive = {
  async test() {
    const script = writeScript(
      'stdio_stdin_wait.js',
      `let buf = "";
       process.stdin.on("data", (d) => { buf += d.toString(); });
       process.stdin.on("end", () => { process.stdout.write("GOT:" + buf); process.exit(0); });`
    );
    const child = spawn('node', [script]);
    const readOut = collect(child.stdout);
    child.stdin.write('part1-');
    await new Promise((r) => setTimeout(r, 150));
    child.stdin.write('part2');
    child.stdin.end();
    const code = await new Promise((resolve) => child.on('exit', resolve));
    strictEqual(code, 0);
    ok(
      readOut().includes('GOT:part1-part2'),
      `child must stay alive across the stdin gap and receive both chunks: ${JSON.stringify(readOut())}`
    );
  },
};

// (c) stdio:"inherit" forwards the child's output to the PARENT's process.stdout/stderr (Node's
// documented semantics: inherit = child writes to the parent's streams). child.stdout is null.
export const inheritForwarding = {
  async test() {
    const script = writeScript(
      'stdio_inherit.js',
      `process.stdout.write("inherited-out\\n");
       process.stderr.write("inherited-err\\n");
       process.exit(0);`
    );
    // In this top-level worker process.stdout/stderr are undefined (they are only patched inside a
    // spawned child by its probe). Install capture objects so we can observe inherit forwarding,
    // which writes to globalThis.process.stdout/stderr; restore them afterwards.
    const captured = { out: [], err: [] };
    const origOut = Object.getOwnPropertyDescriptor(process, 'stdout');
    const origErr = Object.getOwnPropertyDescriptor(process, 'stderr');
    Object.defineProperty(process, 'stdout', {
      configurable: true,
      value: {
        write: (c) => {
          captured.out.push(Buffer.from(c).toString('utf8'));
          return true;
        },
      },
    });
    Object.defineProperty(process, 'stderr', {
      configurable: true,
      value: {
        write: (c) => {
          captured.err.push(Buffer.from(c).toString('utf8'));
          return true;
        },
      },
    });
    let code;
    try {
      const child = spawn('node', [script], { stdio: 'inherit' });
      strictEqual(child.stdout, null, 'inherit => child.stdout is null (no pipe)');
      strictEqual(child.stderr, null, 'inherit => child.stderr is null (no pipe)');
      code = await new Promise((resolve) => child.on('exit', resolve));
    } finally {
      if (origOut) Object.defineProperty(process, 'stdout', origOut);
      if (origErr) Object.defineProperty(process, 'stderr', origErr);
    }
    strictEqual(code, 0);
    ok(
      captured.out.join('').includes('inherited-out'),
      `child stdout must reach parent's process.stdout: ${JSON.stringify(captured.out)}`
    );
    ok(
      captured.err.join('').includes('inherited-err'),
      `child stderr must reach parent's process.stderr: ${JSON.stringify(captured.err)}`
    );
  },
};

// (d) A child-side write(chunk, enc, cb) invokes its callback. This is the gap that made failed npm
// runs read exit 0: npm's exit-handler flushes through the write-callback chain and only THEN calls
// its real process.exit(code). Here the child only reaches its exit + "CB_OK" if cb fired.
export const writeCallbackHonored = {
  async test() {
    const script = writeScript(
      'stdio_writecb.js',
      `process.stdout.write("x", "utf8", () => {
         process.stdout.write("CB_OK\\n");
         process.exit(3);
       });`
    );
    const child = spawn('node', [script]);
    const readOut = collect(child.stdout);
    const code = await new Promise((resolve) => child.on('exit', resolve));
    const out = readOut();
    ok(
      out.includes('CB_OK'),
      `write callback must fire (chain reached process.exit): ${JSON.stringify(out)}`
    );
    strictEqual(code, 3, 'exit code from the callback-driven process.exit must propagate');
  },
};

// (e) Spawning a nonexistent bin settles on a LATER tick: the resolution-failure exit(127) must be
// visible to a listener attached SYNCHRONOUSLY after spawn() returns (the old bug emitted it
// synchronously inside spawn(), so the listener -- e.g. @npmcli/promise-spawn -- missed it and hung).
export const earlyFailureDeferred = {
  async test() {
    const child = spawn('definitely-not-a-real-bin-xyz-999');
    // Listener attached AFTER spawn() returned -- must still observe the event.
    const code = await new Promise((resolve, reject) => {
      child.on('exit', resolve);
      child.on('error', reject);
      setTimeout(() => reject(new Error('no exit/error event fired')), 2000);
    });
    strictEqual(code, 127, 'unresolved bin => exit 127, delivered on a later tick');
  },
};
