// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// FORK-ONLY (native-spawn observability, gap #2): pid/ppid + lifecycle event stream.
//
// Native spawn has no OS process model, so the runtime assigns pids (a process-global monotonic
// counter; pid 1 is the root DO) and emits spawn/exit lifecycle events onto a process-global,
// append-only stream that the parent reads incrementally via `readProcessEvents(cursor)`. These
// tests prove: (a) a spawned child has a numeric pid; (b) a nested spawn's event carries the right
// ppid (a child's pid == its grandchild's ppid -- the chain that reconstructs the pstree); and (c)
// the parent observes spawn+exit events for a subtree INCLUDING a grandchild that has already
// exited (exited natives are observable via the stream, not lost).
//
// This worker has a `workerLoader` binding, which grants native-spawn capability.

import { ok, strictEqual } from 'node:assert';
import { spawn, readProcessEvents } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

function writeScript(name, src) {
  mkdirSync('/tmp', { recursive: true });
  const path = `/tmp/${name}`;
  writeFileSync(path, src);
  return path;
}

// (a) A spawned child has a numeric, plausible pid (>= 2, since pid 1 is the root DO), and a ppid
// pointing at the root (1). The `spawn` event mirrors the handle's pid/ppid.
export const childHasNumericPid = {
  async test() {
    const script = writeScript('obs_simple.js', `process.exit(0);`);
    const startCursor = readProcessEvents(0).cursor;
    const child = spawn('node', [script]);
    strictEqual(typeof child.pid, 'number', 'child.pid must be a number');
    ok(child.pid >= 2, `spawned child pid must be >= 2 (root is 1): ${child.pid}`);
    strictEqual(child.ppid, 1, 'a child of the root DO has ppid 1');
    await new Promise((resolve) => child.on('exit', resolve));

    const { events } = readProcessEvents(startCursor);
    const spawnEv = events.find((e) => e.type === 'spawn' && e.pid === child.pid);
    ok(spawnEv != null, 'a spawn event must be recorded for the child');
    strictEqual(spawnEv.ppid, 1, 'the spawn event carries ppid 1');
    ok(
      Array.isArray(spawnEv.argv) && spawnEv.argv.includes(script),
      `the spawn event carries argv: ${JSON.stringify(spawnEv.argv)}`
    );
  },
};

// (b)+(c) A nested spawn: the root spawns PARENT, which spawns GRANDCHILD, waits for it to exit,
// then exits. After the whole subtree is done, the root reads the event stream and asserts:
//   - the grandchild's spawn event's ppid == the parent's pid (ppid chain reconstructs the tree)
//   - the grandchild (which exited BEFORE the read) is still observable: both its spawn and exit
//     events are present in the stream (exited natives are not lost).
export const nestedSpawnPpidAndExitedObservable = {
  async test() {
    writeScript('obs_grandchild.js', `process.stdout.write("GC"); process.exit(0);`);
    // PARENT requires child_process and spawns the grandchild, waits for its exit, then exits.
    const parentScript = writeScript(
      'obs_parent.js',
      `const { spawn } = require("node:child_process");
       const gc = spawn("node", ["/tmp/obs_grandchild.js"]);
       gc.on("exit", () => { process.stdout.write("PC:gcpid=" + gc.pid); process.exit(0); });`
    );

    const startCursor = readProcessEvents(0).cursor;
    const parent = spawn('node', [parentScript]);
    const parentPid = parent.pid;
    const outChunks = [];
    parent.stdout.on('data', (c) => outChunks.push(Buffer.from(c)));
    const code = await new Promise((resolve) => parent.on('exit', resolve));
    strictEqual(code, 0, 'parent must exit 0');

    const { events } = readProcessEvents(startCursor);

    // The parent's own spawn event: pid == parentPid, ppid == 1 (root).
    const parentSpawn = events.find((e) => e.type === 'spawn' && e.pid === parentPid);
    ok(parentSpawn != null, 'parent spawn event must be present');
    strictEqual(parentSpawn.ppid, 1, 'parent ppid is the root (1)');

    // The grandchild's spawn event: its ppid MUST equal the parent's pid (the ppid chain).
    const gcSpawn = events.find(
      (e) =>
        e.type === 'spawn' &&
        Array.isArray(e.argv) &&
        e.argv.includes('/tmp/obs_grandchild.js')
    );
    ok(gcSpawn != null, 'grandchild spawn event must be present (nested spawn observed at root)');
    strictEqual(
      gcSpawn.ppid,
      parentPid,
      `grandchild.ppid (${gcSpawn.ppid}) must equal parent.pid (${parentPid})`
    );
    ok(gcSpawn.pid >= 2 && gcSpawn.pid !== parentPid, 'grandchild has its own distinct pid');

    // The grandchild EXITED before this read, yet its exit event is observable in the stream.
    const gcExit = events.find((e) => e.type === 'exit' && e.pid === gcSpawn.pid);
    ok(gcExit != null, 'exited grandchild must remain observable via the exit event');
    strictEqual(gcExit.code, 0, 'grandchild exit code recorded');

    // And the parent's exit event too.
    const parentExit = events.find((e) => e.type === 'exit' && e.pid === parentPid);
    ok(parentExit != null, 'parent exit event must be present');

    // Sanity: the parent actually observed the grandchild's pid at runtime (its process.pid was
    // injected), matching the pid the stream recorded.
    const out = Buffer.concat(outChunks).toString('utf8');
    ok(out.includes(`gcpid=${gcSpawn.pid}`), `parent saw grandchild pid: ${JSON.stringify(out)}`);
  },
};
