// Copyright (c) 2017-2022 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// FORK-ONLY (native-spawn): type declarations for the C++ ChildProcessUtil module
// (src/workerd/api/node/child-process.h). It exposes the internal WorkerLoader over the current
// worker's spawn loader channel, which node:child_process.spawn() uses to launch sub-isolate
// "processes" without any JS-visible binding.

// The Fetcher returned by WorkerStub.getEntrypoint(); its methods are JS-RPC wildcard
// properties, so we model just the `run()` method the spawn probe exposes.
export interface SpawnedProcessEntrypoint {
  run(): Promise<unknown>;
}

export interface SpawnedWorkerStub {
  getEntrypoint(
    name?: string,
    options?: Record<string, unknown>
  ): SpawnedProcessEntrypoint;
}

export interface SpawnWorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  allowExperimental?: boolean;
  mainModule: string;
  modules: Record<string, string>;
  shareParentTmp?: boolean;
  vfsModuleFallback?: boolean;
  drainProcess?: boolean;
  allowSpawn?: boolean;
}

export interface SpawnWorkerLoader {
  load(code: SpawnWorkerCode): SpawnedWorkerStub;
}

export interface ChildProcessUtil {
  getSpawnLoader(): SpawnWorkerLoader | undefined;
  // waitpid bracket: while a spawned child's drain RPC is outstanding, the SPAWNER's own
  // drainProcess must not declare quiescence. Balance every spawnBegin with a spawnEnd.
  spawnBegin(): void;
  spawnEnd(): void;
}

declare const util: ChildProcessUtil;
export default util;
