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

// 6) package.json "exports" — STRING sugar form for ".".
export let exportsStringSugar = {
  async test(ctrl, env, ctx) {
    mkdirpAndWrite(
      '/tmp/node_modules/expstr/package.json',
      JSON.stringify({ name: 'expstr', exports: './dist/main.js' })
    );
    mkdirpAndWrite(
      '/tmp/node_modules/expstr/dist/main.js',
      `export const tag = "expstr-string";`
    );
    // A file at the legacy main location that must NOT win (exports takes precedence).
    mkdirpAndWrite('/tmp/node_modules/expstr/index.js', `export const tag = "WRONG";`);

    const c = env.loader.get('vfs-exports-string', () =>
      child(`
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { tag } from "expstr";
        export default class extends WorkerEntrypoint {
          run() { return tag; }
        }
      `)
    );
    assert.strictEqual(await c.getEntrypoint().run(), 'expstr-string');
  },
};

// 7) package.json "exports" — CONDITIONS object (import vs require). We must pick "import" for ESM
//    and "require" for CJS, and must NOT pick "browser".
export let exportsConditions = {
  async test(ctrl, env, ctx) {
    mkdirpAndWrite(
      '/tmp/node_modules/expcond/package.json',
      JSON.stringify({
        name: 'expcond',
        exports: {
          '.': {
            browser: './browser.js',
            import: './esm/index.js',
            require: './cjs/index.js',
            default: './default.js',
          },
        },
      })
    );
    mkdirpAndWrite('/tmp/node_modules/expcond/esm/index.js', `export const which = "esm";`);
    mkdirpAndWrite(
      '/tmp/node_modules/expcond/cjs/index.js',
      `module.exports = { which: "cjs" };`
    );
    mkdirpAndWrite('/tmp/node_modules/expcond/browser.js', `export const which = "browser";`);

    const c = env.loader.get('vfs-exports-cond', () =>
      child(`
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { createRequire } from "node:module";
        import { which as esmWhich } from "expcond";
        const require = createRequire("/tmp/main.js");
        export default class extends WorkerEntrypoint {
          run() {
            const cjsWhich = require("expcond").which;
            return esmWhich + ":" + cjsWhich;
          }
        }
      `)
    );
    assert.strictEqual(await c.getEntrypoint().run(), 'esm:cjs');
  },
};

// 8) package.json "exports" — explicit SUBPATH ("./feature") + blocking of a non-exported deep path.
export let exportsSubpath = {
  async test(ctrl, env, ctx) {
    mkdirpAndWrite(
      '/tmp/node_modules/expsub/package.json',
      JSON.stringify({
        name: 'expsub',
        exports: {
          '.': './index.js',
          './feature': './lib/feature.js',
        },
      })
    );
    mkdirpAndWrite('/tmp/node_modules/expsub/index.js', `export const root = "root";`);
    mkdirpAndWrite(
      '/tmp/node_modules/expsub/lib/feature.js',
      `export const feature = "feature-ok";`
    );
    // Present on disk but NOT in exports -> must be blocked.
    mkdirpAndWrite('/tmp/node_modules/expsub/lib/secret.js', `export const secret = "leak";`);

    const c = env.loader.get('vfs-exports-subpath', () =>
      child(`
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { feature } from "expsub/feature";
        export default class extends WorkerEntrypoint {
          run() { return feature; }
          async blocked() {
            // Not in exports; must fail to resolve.
            await import("expsub/lib/secret.js");
            return "should-not-reach";
          }
        }
      `)
    );
    const ep = c.getEntrypoint();
    assert.strictEqual(await ep.run(), 'feature-ok');
    await assert.rejects(
      async () => { await ep.blocked(); },
      (err) => /module|resolve|No such|not found/i.test(String(err)),
      'a deep path not listed in exports must be blocked'
    );
  },
};

// 9) package.json "exports" — SUBPATH PATTERN ("./*" -> "./dist/*.js" with * substitution).
export let exportsSubpathPattern = {
  async test(ctrl, env, ctx) {
    mkdirpAndWrite(
      '/tmp/node_modules/exppat/package.json',
      JSON.stringify({
        name: 'exppat',
        exports: {
          '.': './dist/index.js',
          './*': './dist/*.js',
        },
      })
    );
    mkdirpAndWrite('/tmp/node_modules/exppat/dist/index.js', `export const k = "idx";`);
    mkdirpAndWrite('/tmp/node_modules/exppat/dist/widget.js', `export const k = "widget";`);

    const c = env.loader.get('vfs-exports-pattern', () =>
      child(`
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { k } from "exppat/widget";
        export default class extends WorkerEntrypoint {
          run() { return k; }
        }
      `)
    );
    assert.strictEqual(await c.getEntrypoint().run(), 'widget');
  },
};

// 10) package.json "imports" — "#"-prefixed internal map (relative target + condition).
export let importsHashMap = {
  async test(ctrl, env, ctx) {
    mkdirpAndWrite(
      '/tmp/node_modules/imppkg/package.json',
      JSON.stringify({
        name: 'imppkg',
        type: 'module',
        main: './index.js',
        imports: {
          '#internal': { import: './internal/impl.js', default: './internal/impl.js' },
          '#util/*': './utils/*.js',
        },
      })
    );
    mkdirpAndWrite(
      '/tmp/node_modules/imppkg/index.js',
      `import { secret } from "#internal";
       import { up } from "#util/strings";
       export const result = secret + ":" + up("x");`
    );
    mkdirpAndWrite(
      '/tmp/node_modules/imppkg/internal/impl.js',
      `export const secret = "from-internal";`
    );
    mkdirpAndWrite(
      '/tmp/node_modules/imppkg/utils/strings.js',
      `export function up(s) { return s.toUpperCase(); }`
    );

    const c = env.loader.get('vfs-imports-hash', () =>
      child(`
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { result } from "imppkg";
        export default class extends WorkerEntrypoint {
          run() { return result; }
        }
      `)
    );
    assert.strictEqual(await c.getEntrypoint().run(), 'from-internal:X');
  },
};

// 11) Control: a child WITHOUT vfsModuleFallback must NOT be able to import from /tmp.
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
