// FORK-ONLY (vfs-module-loading): proves a Worker-Loader child can resolve and RUN JS modules
// (ESM + CJS, relative + bare specifiers, node_modules + package.json) loaded entirely from the
// in-isolate VFS /tmp it shares with the parent.
//
// The parent (which has native node:fs to /tmp) writes module sources into /tmp, then loads a
// child with `vfsModuleFallback: true` (+ `shareParentTmp: true` so the child's /tmp IS the
// parent's). The child's main module imports/requires those VFS modules and returns a computed
// result. This is the keystone: npm-installed code under /tmp/node_modules becomes import/require-
// able inside a child via workerd's native module system, with no fallback service / RPC / thread.

import assert from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHILD_FLAGS = [
  'nodejs_compat',
  'nodejs_compat_v2',
  'experimental',
  'enable_nodejs_fs_module',
];

function child(mainModule) {
  return {
    compatibilityDate: '2025-01-01',
    compatibilityFlags: CHILD_FLAGS,
    allowExperimental: true,
    shareParentTmp: true,
    vfsModuleFallback: true,
    mainModule: 'main.js',
    modules: { 'main.js': mainModule },
  };
}

function mkdirpAndWrite(path, contents) {
  const dir = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, contents);
}

// 1) Bare ESM specifier resolved from /tmp/node_modules with package.json "main".
export let bareEsmFromNodeModules = {
  async test(ctrl, env, ctx) {
    mkdirpAndWrite(
      '/tmp/node_modules/greet/package.json',
      JSON.stringify({ name: 'greet', version: '1.0.0', main: 'lib/index.js' })
    );
    mkdirpAndWrite(
      '/tmp/node_modules/greet/lib/index.js',
      `export default function greet(name) { return "hi " + name; }
       export const VERSION = "1.0.0";`
    );

    const c = env.loader.get('vfs-bare-esm', () =>
      child(`
        import { WorkerEntrypoint } from "cloudflare:workers";
        import greet, { VERSION } from "greet";
        export default class extends WorkerEntrypoint {
          run() { return greet("world") + " v" + VERSION; }
        }
      `)
    );
    const result = await c.getEntrypoint().run();
    assert.strictEqual(result, 'hi world v1.0.0');
  },
};

// 2) CommonJS require() of a bare package (module.exports = fn) from /tmp/node_modules.
export let bareCjsFromNodeModules = {
  async test(ctrl, env, ctx) {
    mkdirpAndWrite(
      '/tmp/node_modules/adder/package.json',
      JSON.stringify({ name: 'adder', version: '2.0.0', main: 'index.js' })
    );
    mkdirpAndWrite(
      '/tmp/node_modules/adder/index.js',
      `module.exports = function add(a, b) { return a + b; };
       module.exports.label = "adder";`
    );

    const c = env.loader.get('vfs-bare-cjs', () =>
      child(`
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { createRequire } from "node:module";
        const require = createRequire("/tmp/main.js");
        const add = require("adder");
        export default class extends WorkerEntrypoint {
          run() { return add(2, 3) + ":" + add.label; }
        }
      `)
    );
    const result = await c.getEntrypoint().run();
    assert.strictEqual(result, '5:adder');
  },
};

// 3) Relative imports + transitive resolution + a JSON module, all from /tmp.
export let relativeAndJson = {
  async test(ctrl, env, ctx) {
    mkdirpAndWrite('/tmp/proj/data.json', JSON.stringify({ factor: 10 }));
    mkdirpAndWrite(
      '/tmp/proj/helper.js',
      `import data from "./data.json";
       export function scale(x) { return x * data.factor; }`
    );
    mkdirpAndWrite(
      '/tmp/proj/entry.js',
      `import { scale } from "./helper.js";
       export function compute() { return scale(4); }`
    );

    const c = env.loader.get('vfs-relative', () =>
      child(`
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { compute } from "/tmp/proj/entry.js";
        export default class extends WorkerEntrypoint {
          run() { return compute(); }
        }
      `)
    );
    const result = await c.getEntrypoint().run();
    assert.strictEqual(result, 40);
  },
};

// 4) A package that itself require()s a transitive dependency from node_modules.
export let transitiveNodeModules = {
  async test(ctrl, env, ctx) {
    mkdirpAndWrite(
      '/tmp/node_modules/dep/package.json',
      JSON.stringify({ name: 'dep', main: 'index.js' })
    );
    mkdirpAndWrite('/tmp/node_modules/dep/index.js', `module.exports = { value: 7 };`);
    mkdirpAndWrite(
      '/tmp/node_modules/top/package.json',
      JSON.stringify({ name: 'top', main: 'index.js' })
    );
    mkdirpAndWrite(
      '/tmp/node_modules/top/index.js',
      `const dep = require("dep"); module.exports = function () { return dep.value * 6; };`
    );

    const c = env.loader.get('vfs-transitive', () =>
      child(`
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { createRequire } from "node:module";
        const require = createRequire("/tmp/main.js");
        const top = require("top");
        export default class extends WorkerEntrypoint {
          run() { return top(); }
        }
      `)
    );
    const result = await c.getEntrypoint().run();
    assert.strictEqual(result, 42);
  },
};

// 5) Control: a child WITHOUT vfsModuleFallback must NOT be able to import from /tmp.
export let controlNoFallbackFails = {
  async test(ctrl, env, ctx) {
    mkdirpAndWrite(
      '/tmp/node_modules/secret/index.js',
      `export const value = "should-not-load";`
    );

    const c = env.loader.get('vfs-control', () => {
      const code = child(`
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { value } from "secret";
        export default class extends WorkerEntrypoint {
          run() { return value; }
        }
      `);
      code.vfsModuleFallback = false; // opt out
      return code;
    });

    await assert.rejects(
      async () => {
        await c.getEntrypoint().run();
      },
      (err) => {
        // workerd reports an unresolved module error.
        return /module|resolve|No such|not found/i.test(String(err));
      },
      'child without vfsModuleFallback must fail to import from /tmp'
    );
  },
};
