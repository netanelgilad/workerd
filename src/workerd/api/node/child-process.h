#pragma once

// FORK-ONLY (native-spawn): C++ backing for node:child_process.
//
// In this fork, "spawning a process" means loading a dynamic sub-isolate over the shared /tmp
// VFS and running it to event-loop quiescence (drainProcess). The JS half of the implementation
// lives in src/node/child_process.ts; this module provides the one capability JS cannot get on
// its own: an internal WorkerLoader that reaches the current worker's spawn loader channel
// (IoChannelFactory::getSpawnLoaderChannel()) WITHOUT a JS-visible binding. That is what lets an
// isolate that was itself launched as a "process" (allowSpawn) spawn further processes
// recursively -- no env plumbing, no userland bridge.

#include <workerd/api/worker-loader.h>
#include <workerd/jsg/jsg.h>

namespace workerd::api::node {

class ChildProcessUtil final: public jsg::Object {
 public:
  ChildProcessUtil() = default;
  ChildProcessUtil(jsg::Lock&, const jsg::Url&) {}

  // Returns a WorkerLoader over the current worker's spawn loader channel, or undefined when the
  // current worker has no spawn capability (i.e. it has no workerLoader binding and was not
  // dynamically loaded with `allowSpawn: true`).
  jsg::Optional<jsg::Ref<WorkerLoader>> getSpawnLoader(jsg::Lock& js);

  // waitpid semantics for drainProcess: child_process.spawn() brackets each child's lifetime
  // (spawnBegin before loading the sub-isolate, spawnEnd when its drain RPC settles) so that
  // IoContext::runToQuiescence() does not declare the SPAWNER quiescent while it still has live
  // children. Without this, the RPC await is invisible to the drain heuristic.
  void spawnBegin(jsg::Lock& js);
  void spawnEnd(jsg::Lock& js);

  // FORK-ONLY (native-spawn observability, gap #2): process-global spawn lifecycle bus.
  //
  // A native-spawn "process" has no OS pid, so the runtime hands out its own. nextPid() returns a
  // process-global, monotonic, stable pid; pid 1 is reserved for the root Durable Object (workerd's
  // default process.pid), so the first spawned child is pid 2. A child learns its own pid via
  // process.pid (the probe injects it) and stamps that as its children's ppid -- so ppid chains
  // reconstruct the full pstree.
  //
  // Lifecycle events (spawn/exit, carrying pid + ppid + argv/code) are appended to one
  // process-global, append-only log as they happen. A consumer (the root DO / iso) reads it
  // incrementally via a cursor -- an EVENT STREAM, not a live snapshot table: exited processes stay
  // in the log, so both a live pstree and an exited-history view are reconstructible. Emitting an
  // event is a synchronous, non-blocking append: it never keeps a process alive or blocks
  // drainProcess quiescence. The log is process-global (all isolates share it); a consumer scopes
  // to its own subtree by following ppid links from its root pid.
  uint nextPid(jsg::Lock& js);
  void emitLifecycleEvent(jsg::Lock& js, kj::String json);
  kj::Array<kj::String> readLifecycleEvents(jsg::Lock& js, uint cursor);

  JSG_RESOURCE_TYPE(ChildProcessUtil) {
    JSG_METHOD(getSpawnLoader);
    JSG_METHOD(spawnBegin);
    JSG_METHOD(spawnEnd);
    JSG_METHOD(nextPid);
    JSG_METHOD(emitLifecycleEvent);
    JSG_METHOD(readLifecycleEvents);
  }
};

#define EW_NODE_CHILD_PROCESS_ISOLATE_TYPES api::node::ChildProcessUtil

}  // namespace workerd::api::node
