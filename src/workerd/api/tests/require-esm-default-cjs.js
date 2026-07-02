// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// The CJS requirer for the fork gap #4 regression test. It require()s a sibling
// ESM module that has a `default` export and re-exports what require() handed
// back, so the test can assert on the exact value/shape from a real CJS call
// site (not just createRequire from ESM).
const x = require('esm-with-default');

module.exports = {
  x,
  // Snapshot of what require() returned, observed from inside CJS: the marker
  // is only reachable if `x` is the default export itself; `gotNamed` proves
  // the named exports are NOT present on what require() returned.
  gotDefaultMarker: x.marker,
  gotNamed: x.named,
};
