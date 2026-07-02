// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// FORK REGRESSION LOCK (fork gap #4): CJS `require()` of a user-bundle ESM
// module that has a `default` export returns the DEFAULT EXPORT ITSELF, not a
// namespace object wrapping it. iso's in-context-require loader for exec'd
// scripts relies on this exact shape; this test pins it so it cannot silently
// change. The behavior is produced by ModuleRegistry::requireImpl in
// jsg/modules.c++ (require_returns_default_export path) reached via
// CommonJsModuleContext::require in api/commonjs.c++. The flag is enabled by
// the 2026-01-22 compat date used here, matching iso's runtime config.
import { strictEqual, notStrictEqual, ok } from 'node:assert';
import * as esmNamespace from 'esm-with-default';

// `cjs-requirer` did `const x = require('esm-with-default')` and re-exported it
// as `module.exports.x`. When ESM imports a CJS module the default export is
// module.exports, so `requirer` here is that `{ x, isNamespaceObject, ... }`.
import requirer from 'cjs-requirer';

export const requireEsmReturnsDefaultExportItself = {
  test() {
    const x = requirer.x;

    // x IS the default export value, not a namespace wrapping it.
    strictEqual(x, esmNamespace.default);
    strictEqual(x.marker, 'i-am-the-default-export');
    strictEqual(x.fn(), 'called');

    // x is NOT the namespace object: it carries none of the named exports and
    // has no `default` self-reference.
    notStrictEqual(x, esmNamespace);
    strictEqual(x.named, undefined);
    strictEqual(x.another, undefined);
    strictEqual(x.default, undefined);

    // Sanity: the real namespace (static `import *`) does carry the named
    // exports and a `default` pointing back at x.
    strictEqual(esmNamespace.named, 'i-am-a-named-export');
    strictEqual(esmNamespace.another, 123);
    strictEqual(esmNamespace.default, x);

    // The CJS module observed the same: what it required was the default, and
    // it was not the namespace object.
    ok(requirer.gotDefaultMarker === 'i-am-the-default-export');
    strictEqual(requirer.gotNamed, undefined);
  },
};
