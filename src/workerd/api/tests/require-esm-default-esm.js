// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// The ESM target for the fork gap #4 regression test. It has a distinctive
// `default` export plus named exports so the test can prove `require()` returns
// the default itself, not the namespace.
export const named = 'i-am-a-named-export';
export const another = 123;

const theDefault = {
  marker: 'i-am-the-default-export',
  fn() {
    return 'called';
  },
};

export default theDefault;
