#include "child-process.h"

#include <workerd/io/compatibility-date.h>
#include <workerd/io/io-context.h>

#include <kj/mutex.h>

#include <atomic>

namespace workerd::api::node {

namespace {

// FORK-ONLY (native-spawn observability, gap #2): the process-global spawn lifecycle bus. One
// monotonic pid counter and one append-only lifecycle event log, shared by every native-spawned
// sub-isolate in this workerd process (they all reach it through node-internal:child_process_util).
// Mutex-guarded because unrelated root workers may run on different threads; a single native-spawn
// SUBTREE is single-threaded (loaded isolates run on the parent's thread). The event log is
// append-only (never trimmed) so exited processes remain observable; for very long-lived processes
// this grows unbounded -- acceptable for observability sessions, a candidate for a capped ring
// buffer later.
struct LifecycleBus {
  // pid 1 is the root DO (workerd's default process.pid); spawned children start at 2.
  std::atomic<uint32_t> nextPid{2};
  kj::MutexGuarded<kj::Vector<kj::String>> events;
};

LifecycleBus& lifecycleBus() {
  static LifecycleBus bus;
  return bus;
}

}  // namespace

jsg::Optional<jsg::Ref<WorkerLoader>> ChildProcessUtil::getSpawnLoader(jsg::Lock& js) {
  // Spawning requires a live IoContext (the loader captures the parent's /tmp and outbound
  // channels from it). Module-eval-time calls simply report "no capability".
  if (!IoContext::hasCurrent()) return kj::none;

  KJ_IF_SOME(channel, IoContext::current().getIoChannelFactory().getSpawnLoaderChannel()) {
    // CODE_VERSION matches how workerd constructs config-declared WorkerLoader bindings
    // (see Server::WorkerdApi Global::WorkerLoader handling in workerd-api.c++).
    return js.alloc<WorkerLoader>(channel, CompatibilityDateValidation::CODE_VERSION);
  }
  return kj::none;
}

void ChildProcessUtil::spawnBegin(jsg::Lock& js) {
  if (IoContext::hasCurrent()) {
    IoContext::current().incrementPendingSpawns();
  }
}

void ChildProcessUtil::spawnEnd(jsg::Lock& js) {
  if (IoContext::hasCurrent()) {
    IoContext::current().decrementPendingSpawns();
  }
}

uint ChildProcessUtil::nextPid(jsg::Lock& js) {
  return lifecycleBus().nextPid.fetch_add(1, std::memory_order_relaxed);
}

void ChildProcessUtil::emitLifecycleEvent(jsg::Lock& js, kj::String json) {
  auto events = lifecycleBus().events.lockExclusive();
  events->add(kj::mv(json));
}

kj::Array<kj::String> ChildProcessUtil::readLifecycleEvents(jsg::Lock& js, uint cursor) {
  auto events = lifecycleBus().events.lockExclusive();
  if (cursor >= events->size()) return {};
  auto builder = kj::heapArrayBuilder<kj::String>(events->size() - cursor);
  for (auto i = cursor; i < events->size(); i++) {
    builder.add(kj::str((*events)[i]));
  }
  return builder.finish();
}

}  // namespace workerd::api::node
