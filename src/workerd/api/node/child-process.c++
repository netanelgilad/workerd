#include "child-process.h"

#include <workerd/io/compatibility-date.h>
#include <workerd/io/io-context.h>

namespace workerd::api::node {

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

}  // namespace workerd::api::node
