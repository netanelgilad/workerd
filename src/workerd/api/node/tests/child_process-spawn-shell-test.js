// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// FORK-ONLY (native-spawn, gap #8): shell mode delegates to a REAL `sh` resolved via PATH; the
// runtime must NOT tokenize/interpret the shell line itself, and must NOT ship builtins. These
// tests wire a STUB `sh` onto PATH that (a) echoes its own argv (proving the compound line reached
// it UNMODIFIED -- one argv element, not tokenized) and (b) does a minimal parse of `-c <line>`
// (proving the combined output is produced by the delegated shell, not the runtime). A direct
// (non-shell) spawn is also covered to prove execvp-style PATH resolution of the program name.
//
// This worker has a `workerLoader` binding, which grants native-spawn capability.

import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const BIN = '/tmp/usr/bin';

function writeBin(name, src) {
  mkdirSync(BIN, { recursive: true });
  const path = `${BIN}/${name}`;
  writeFileSync(path, src);
  return path;
}

function collect(stream) {
  const chunks = [];
  stream.on('data', (c) => chunks.push(Buffer.from(c)));
  return () => Buffer.concat(chunks).toString('utf8');
}

// A stub `sh` that PROVES the runtime handed it the line intact. It emits its own argv (as JSON)
// then does a deliberately tiny "shell": split `-c <line>` on `&&` and run `echo X` segments. If
// the runtime had tokenized the line, `sh` would never have been the resolved program (the first
// token, e.g. `echo`, would be), so none of this output would appear.
const STUB_SH = `
const argv = process.argv.slice(2);
process.stdout.write('ARGV:' + JSON.stringify(argv));
if (argv[0] === '-c' && typeof argv[1] === 'string') {
  for (const seg of argv[1].split('&&').map((s) => s.trim())) {
    const m = seg.match(/^echo\\s+(.*)$/);
    if (m) process.stdout.write('\\nOUT:' + m[1]);
  }
}
process.exit(0);
`;

// (a) Direct (non-shell) spawn resolves the PROGRAM NAME via PATH (execvp-style) and runs it.
export const directSpawnResolvesViaPath = {
  async test() {
    writeBin('greet', `process.stdout.write('GREET-OK'); process.exit(0);`);
    const child = spawn('greet', [], { env: { PATH: BIN } });
    const readOut = collect(child.stdout);
    const code = await new Promise((resolve) => child.on('exit', resolve));
    strictEqual(code, 0);
    ok(
      readOut().includes('GREET-OK'),
      `direct spawn should PATH-resolve and run the program: ${JSON.stringify(readOut())}`
    );
  },
};

// (b) Explicit `sh -c '<compound line>'` is delegated to the real `sh` UNMODIFIED: the child sees
// argv === ['-c', '<the whole line>'] (a single, untokenized string), and the combined output is
// produced by the delegated shell parsing that line -- proving the runtime did not tokenize.
export const explicitShDashCDelegates = {
  async test() {
    writeBin('sh', STUB_SH);
    const line = 'echo a && echo b';
    const child = spawn('sh', ['-c', line], { env: { PATH: BIN } });
    const readOut = collect(child.stdout);
    const code = await new Promise((resolve) => child.on('exit', resolve));
    strictEqual(code, 0);
    const out = readOut();
    const argvJson = out.slice(out.indexOf('ARGV:') + 5, out.indexOf('\n'));
    deepStrictEqual(
      JSON.parse(argvJson),
      ['-c', line],
      `sh must receive the compound line as ONE untokenized argv element: ${JSON.stringify(out)}`
    );
    ok(out.includes('OUT:a'), `delegated sh should run the first segment: ${JSON.stringify(out)}`);
    ok(out.includes('OUT:b'), `delegated sh should run the second segment: ${JSON.stringify(out)}`);
  },
};

// (c) `shell: true` synthesizes `sh -c <line>` (Node POSIX semantics) and routes through the same
// PATH-resolved real `sh` -- again with the line intact, NOT tokenized by the runtime.
export const shellTrueSynthesizesShDashC = {
  async test() {
    writeBin('sh', STUB_SH);
    const child = spawn('echo a && echo b', { shell: true, env: { PATH: BIN } });
    const readOut = collect(child.stdout);
    const code = await new Promise((resolve) => child.on('exit', resolve));
    strictEqual(code, 0);
    const out = readOut();
    const argvJson = out.slice(out.indexOf('ARGV:') + 5, out.indexOf('\n'));
    deepStrictEqual(
      JSON.parse(argvJson),
      ['-c', 'echo a && echo b'],
      `shell:true must delegate the intact line to sh -c: ${JSON.stringify(out)}`
    );
    ok(out.includes('OUT:a') && out.includes('OUT:b'), `combined output via sh: ${JSON.stringify(out)}`);
  },
};

// (d) Shell mode with NO `sh` on PATH fails ENOENT-style (exit 127) -- there is deliberately no
// builtin fallback; the runtime does not interpret the line itself.
export const shellModeNoShFails = {
  async test() {
    // PATH points at an empty dir: `sh` cannot be resolved.
    mkdirSync('/tmp/emptybin', { recursive: true });
    const child = spawn('echo hi', { shell: true, env: { PATH: '/tmp/emptybin' } });
    const code = await new Promise((resolve, reject) => {
      child.on('exit', resolve);
      child.on('error', reject);
      setTimeout(() => reject(new Error('no exit/error fired')), 2000);
    });
    strictEqual(code, 127, 'shell mode with no sh on PATH must fail like a real OS (127)');
  },
};
