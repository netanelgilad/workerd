// FORK-ONLY (native-spawn + shared-tmp-vfs): regression lock for fork gap #3.
//
// Gap #3 (as documented from the iso workstream): a nested native child_process.spawn() from a
// NON-drainProcess child hit EPERM on VFS writes (a registry fetch's cacache mkdir failed), while
// the same write from a drain child succeeded -- the drain/non-drain asymmetry was the sharp edge.
//
// Root cause (now fixed on this branch): before the writable VFS was re-rooted at "/" (commit
// "spike(vfs-root-mount): re-root the shared writable VFS at / instead of /tmp"), only "/tmp" was
// writable and the root "/" was read-only. cacache/npm write to cache paths OUTSIDE /tmp, so those
// writes hit the read-only root -> NOT_PERMITTED (surfacing as EPERM). The re-root made the ENTIRE
// root route to the shared writable store; write permission now depends only on the shared store
// being reachable (RootDirectory::add -> tryGetSharedStore in io/worker-fs.c++), NOT on drain mode.
//
// This test pins that invariant: a nested spawn writes a cacache-shape tree (mkdir + writeFileSync
// under "/", OUTSIDE /tmp) and it must succeed for BOTH a non-drain and a drain spawner -- proving
// the asymmetry is gone. It would have failed pre-re-root (write outside /tmp -> NOT_PERMITTED).
//
// Topology: top worker (has workerLoader binding, can spawn) -> child C (shareParentTmp:true,
// allowSpawn:true, drainProcess toggled per case) -> sub-child S (native spawn) does the write.

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';

const CHILD_FLAGS = [
  'nodejs_compat',
  'nodejs_compat_v2',
  'experimental',
  'enable_nodejs_fs_module',
  'enable_nodejs_child_process_module',
];

// Child C: can spawn (allowSpawn) and shares the parent's writable store. `drain` toggles whether
// C is a drainProcess child -- the whole point of the test is that this bit must NOT affect whether
// the sub-child it spawns can write the shared VFS. Its RPC method writes a sub-child script to the
// shared /tmp, spawns it via native child_process.spawn, and reports the sub-child's exit code +
// stderr so the parent can see any EPERM the sub-child hit.
function spawnerCode(drain) {
  return {
    compatibilityDate: '2025-01-01',
    compatibilityFlags: CHILD_FLAGS,
    allowExperimental: true,
    shareParentTmp: true,
    allowSpawn: true,
    drainProcess: drain,
    mainModule: 'child.js',
    modules: {
      'child.js': `
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";

        export default class extends WorkerEntrypoint {
          // Spawn a sub-child that does a cacache-shape write: mkdir under "/" (OUTSIDE /tmp) +
          // writeFileSync. Returns { code, stderr } from the sub-child.
          async nestedSpawnWrite(dir, file, contents) {
            const scriptPath = "/tmp/nested-s-script.js";
            writeFileSync(
              scriptPath,
              "const { mkdirSync, writeFileSync } = require('node:fs');\\n" +
              "mkdirSync(" + JSON.stringify(dir) + ", { recursive: true });\\n" +
              "writeFileSync(" + JSON.stringify(file) + ", " + JSON.stringify(contents) + ");\\n" +
              "process.stdout.write('S-OK');\\n"
            );
            const child = spawn("node", [scriptPath]);
            const errChunks = [];
            child.stderr.on("data", (c) => errChunks.push(Buffer.from(c)));
            const code = await new Promise((resolve, reject) => {
              child.on("exit", resolve);
              child.on("error", reject);
            });
            return { code, stderr: Buffer.concat(errChunks).toString("utf8") };
          }
        }
      `,
    },
  };
}

// Drive one nested-spawn write through a spawner with the given drain mode and assert it succeeded
// and the bytes are readable from the top worker (shared store).
async function runNestedWrite(env, { drain, tag }) {
  const dir = `/nested-cache/${tag}/content-v2`;
  const file = `${dir}/blob-${Date.now().toString(36)}`;
  const contents = `cacache bytes via ${tag}`;

  const spawner = env.loader.get(`spawner-${tag}`, () => spawnerCode(drain));
  const result = await spawner.getEntrypoint().nestedSpawnWrite(dir, file, contents);

  assert.strictEqual(
    result.code,
    0,
    `[${tag}] sub-child must exit 0 (no EPERM). stderr: ${result.stderr}`
  );
  assert.ok(
    !/EPERM|not permitted|NOT_PERMITTED/i.test(result.stderr),
    `[${tag}] sub-child must not hit EPERM writing the shared VFS. stderr: ${result.stderr}`
  );
  assert.ok(existsSync(file), `[${tag}] parent must see the file the nested sub-child wrote: ${file}`);
  assert.strictEqual(
    readFileSync(file, 'utf8'),
    contents,
    `[${tag}] parent must read the exact bytes the nested sub-child wrote`
  );
}

// A nested spawn from a NON-drain child must write the shared VFS (outside /tmp) without EPERM.
// This is the exact gap #3 scenario.
export const nestedSpawnFromNonDrainChildCanWriteVfs = {
  async test(ctrl, env, ctx) {
    await runNestedWrite(env, { drain: false, tag: 'nondrain' });
  },
};

// Symmetry: the same nested spawn from a DRAIN child must also succeed. Both passing proves write
// permission is independent of drain mode (the gap #3 asymmetry is gone), and guards the drain path.
export const nestedSpawnFromDrainChildCanWriteVfs = {
  async test(ctrl, env, ctx) {
    await runNestedWrite(env, { drain: true, tag: 'drain' });
  },
};
