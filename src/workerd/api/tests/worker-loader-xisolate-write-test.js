// FORK-ONLY (shared-tmp-vfs): regression test for fork gap #5 -- cross-isolate
// IN-PLACE writeFileSync into the shared /tmp store.
//
// The DO/parent isolate (isolate A) creates a file in the shared store; a spawned
// child isolate (isolate B, loaded with shareParentTmp: true) then writeFileSync's
// the SAME path with new content. Before the fix this threw "internal error;
// reference = ..." because the file's external-memory adjustment was anchored to
// isolate A, and isolate B's in-place mutation (truncate/grow via resize) poked
// A's isolate accounting, tripping the isolate-affinity assert -- and npm's error
// rollback then DELETED the file. After the fix the shared file's byte buffer is
// isolate-agnostic: B's write re-anchors accounting to B, both isolates read the
// new content, and the file survives.

import assert from 'node:assert';
import { writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';

const CHILD_FLAGS = [
  'nodejs_compat',
  'nodejs_compat_v2',
  'experimental',
  'enable_nodejs_fs_module',
];

function childCode() {
  return {
    compatibilityDate: '2025-01-01',
    compatibilityFlags: CHILD_FLAGS,
    allowExperimental: true,
    mainModule: 'child.js',
    shareParentTmp: true,
    modules: {
      'child.js': `
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

        export default class extends WorkerEntrypoint {
          // In-place overwrite (writeFileSync truncates + rewrites) a path the parent owns.
          overwrite(path, contents) {
            writeFileSync(path, contents);
            return readFileSync(path, "utf8");
          }
          append(path, extra) {
            appendFileSync(path, extra);
            return readFileSync(path, "utf8");
          }
          read(path) {
            if (!existsSync(path)) return null;
            return readFileSync(path, "utf8");
          }
        }
      `,
    },
  };
}

// (a) truncating overwrite: parent writes a LONGER string, child overwrites with a
// SHORTER one (exercises resize-down / truncate) then a check with a LONGER one.
export let crossIsolateTruncatingOverwrite = {
  async test(ctrl, env, ctx) {
    const path = '/tmp/xwrite-overwrite.txt';
    const original = 'ORIGINAL content written by the parent isolate A';
    const replacement = 'short from B';

    writeFileSync(path, original);
    assert.strictEqual(readFileSync(path, 'utf8'), original);

    const child = env.loader.get('xwrite-child', childCode);

    // The exact fork-gap-#5 repro: child writeFileSync over a parent-owned path.
    const childSaw = await child.getEntrypoint().overwrite(path, replacement);

    assert.strictEqual(
      childSaw,
      replacement,
      'child must read back its own new content after in-place overwrite'
    );
    assert.ok(existsSync(path), 'file must still exist (not deleted by a failed write)');
    assert.strictEqual(
      readFileSync(path, 'utf8'),
      replacement,
      'parent must read the NEW content the child wrote in place'
    );

    // And grow it again from the child (resize-up across isolates).
    const longer = 'a much longer replacement string coming from isolate B again #2';
    const childSaw2 = await child.getEntrypoint().overwrite(path, longer);
    assert.strictEqual(childSaw2, longer);
    assert.strictEqual(readFileSync(path, 'utf8'), longer, 'parent sees grown content');
  },
};

// (b) append: child appends to a parent-owned file (exercises resize-grow via write
// at a non-zero offset, cross-isolate).
export let crossIsolateAppend = {
  async test(ctrl, env, ctx) {
    const path = '/tmp/xwrite-append.txt';
    const base = 'base-from-parent;';
    const extra = 'extra-from-child';

    writeFileSync(path, base);
    const child = env.loader.get('xwrite-child-append', childCode);

    const childSaw = await child.getEntrypoint().append(path, extra);
    assert.strictEqual(childSaw, base + extra, 'child reads base+extra after append');
    assert.ok(existsSync(path), 'file must still exist after cross-isolate append');
    assert.strictEqual(
      readFileSync(path, 'utf8'),
      base + extra,
      'parent must read the appended content'
    );
  },
};

// (c) bounce: after the child overwrites, the PARENT overwrites in place again
// (re-anchor back to A) and the child reads the newest content. Proves accounting
// re-anchors both directions without error or data loss.
export let crossIsolateBounce = {
  async test(ctrl, env, ctx) {
    const path = '/tmp/xwrite-bounce.txt';
    writeFileSync(path, 'v1-parent');

    const child = env.loader.get('xwrite-child-bounce', childCode);
    assert.strictEqual(await child.getEntrypoint().overwrite(path, 'v2-child'), 'v2-child');

    // Parent overwrites in place again (was written last by B).
    writeFileSync(path, 'v3-parent-again');
    assert.strictEqual(readFileSync(path, 'utf8'), 'v3-parent-again');

    // Child reads newest, then overwrites once more.
    assert.strictEqual(await child.getEntrypoint().read(path), 'v3-parent-again');
    assert.strictEqual(
      await child.getEntrypoint().overwrite(path, 'v4-child'),
      'v4-child'
    );
    assert.strictEqual(readFileSync(path, 'utf8'), 'v4-child');
  },
};
