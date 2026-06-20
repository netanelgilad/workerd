// FORK-ONLY (shared-tmp-vfs): integration test proving that a dynamically-loaded
// (child) worker can share the parent worker's writable /tmp virtual filesystem when
// `shareParentTmp: true` is passed to the Worker Loader, and that the default (omitted
// / false) behavior keeps /tmp isolated.
//
// The child workers expose RPC methods (via WorkerEntrypoint) that read/write /tmp using
// native node:fs, so the parent can drive them and assert on the results.

import assert from 'node:assert';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

// Common child compat config. node:fs requires nodejs_compat / nodejs_compat_v2 plus the
// enable_nodejs_fs_module flag (see fs-*-test.wd-test).
const CHILD_FLAGS = [
  'nodejs_compat',
  'nodejs_compat_v2',
  'experimental',
  'enable_nodejs_fs_module',
];

function childCode(shareParentTmp) {
  return {
    compatibilityDate: '2025-01-01',
    compatibilityFlags: CHILD_FLAGS,
    allowExperimental: true,
    mainModule: 'child.js',
    shareParentTmp,
    modules: {
      'child.js': `
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { existsSync, readFileSync, writeFileSync } from "node:fs";

        export default class extends WorkerEntrypoint {
          // Returns the file contents, or null if the file does not exist.
          readProof(path) {
            if (!existsSync(path)) return null;
            return readFileSync(path, "utf8");
          }
          // Writes a file from the child side (for the bidirectional check).
          writeProof(path, contents) {
            writeFileSync(path, contents);
            return true;
          }
        }
      `,
    },
  };
}

export let sharedTmpVisibleToChild = {
  async test(ctrl, env, ctx) {
    const path = '/tmp/shared-proof.txt';
    const expected = 'hello from parent ' + Date.now();

    // Parent writes to its own /tmp.
    writeFileSync(path, expected);
    assert.ok(existsSync(path), 'parent should see its own /tmp file');

    // Child loaded WITH shareParentTmp: true should see the parent's file.
    const sharedChild = env.loader.get('shared-child', () => childCode(true));
    const seen = await sharedChild.getEntrypoint().readProof(path);
    assert.strictEqual(
      seen,
      expected,
      'child with shareParentTmp:true must read the file the parent wrote to /tmp'
    );
  },
};

export let isolatedTmpHiddenFromControlChild = {
  async test(ctrl, env, ctx) {
    const path = '/tmp/control-proof.txt';
    writeFileSync(path, 'parent-only-secret');
    assert.ok(existsSync(path), 'parent should see its own /tmp file');

    // Control child loaded WITHOUT shareParentTmp must NOT see the parent's file.
    const controlChild = env.loader.get('control-child', () => childCode(false));
    const seen = await controlChild.getEntrypoint().readProof(path);
    assert.strictEqual(
      seen,
      null,
      'control child (no shareParentTmp) must NOT see the parent /tmp file'
    );

    // Sanity: an explicitly omitted flag behaves the same as false.
    const omittedChild = env.loader.get('omitted-child', () => {
      const code = childCode(false);
      delete code.shareParentTmp;
      return code;
    });
    const seenOmitted = await omittedChild.getEntrypoint().readProof(path);
    assert.strictEqual(
      seenOmitted,
      null,
      'child with shareParentTmp omitted must NOT see the parent /tmp file'
    );
  },
};

export let bidirectionalSharing = {
  async test(ctrl, env, ctx) {
    const childPath = '/tmp/child-wrote.txt';
    const childContents = 'hello from child ' + Date.now();

    // The parent should NOT see the file before the child writes it.
    assert.ok(!existsSync(childPath), 'file should not exist yet');

    // Child (sharing /tmp) writes a file; parent should then see it.
    const sharedChild = env.loader.get('shared-child-bidi', () => childCode(true));
    const wrote = await sharedChild.getEntrypoint().writeProof(childPath, childContents);
    assert.strictEqual(wrote, true);

    assert.ok(
      existsSync(childPath),
      'parent must see the file the shared child wrote to /tmp'
    );
    assert.strictEqual(
      readFileSync(childPath, 'utf8'),
      childContents,
      'parent must read the exact contents the shared child wrote'
    );
  },
};
