#pragma once
// FORK-ONLY (vfs-module-loading): node-style module resolution against the worker's OWN virtual
// filesystem (VFS) -- specifically the shared /tmp directory.
//
// This is the keystone for "DO as a JS machine": a Worker-Loader child that opts in (via
// WorkerCode.vfsModuleFallback) gets a module fallback that performs node-style resolution
// (relative paths, bare specifiers via node_modules walking, package.json main/module, file
// extensions, CJS vs ESM detection) by reading files directly out of the in-isolate VFS.
//
// When combined with WorkerCode.shareParentTmp the child's /tmp IS the parent Durable Object's
// writable /tmp, so npm-installed code under /tmp/node_modules can be import()/require()d and RUN
// by workerd's native module system inside the child -- with no RPC, no socket, and no separate
// thread, because the VFS is in-memory and synchronous on the same thread.
//
// To avoid dragging the heavy jsg type-wrapper / workerd-api machinery into this translation unit,
// this resolver does NOT compile the module itself. It performs resolution + classification and
// returns either a redirect or a capnp `Worker::Module` message; the caller (server.c++, which has
// the full jsg context) turns that into a jsg::ModuleRegistry::ModuleInfo via
// WorkerdApi::tryCompileModule.

#include <workerd/jsg/modules.h>

#include <capnp/message.h>

#include <kj/common.h>
#include <kj/one-of.h>
#include <kj/refcount.h>
#include <kj/string.h>

namespace workerd {
class Directory;
}

namespace workerd::server {

// Result of a successful VFS resolution.
struct VfsResolveResult {
  // A redirect: a workerd module specifier the registry should resolve instead of the original.
  // When set, `moduleMessage` is null.
  kj::Maybe<kj::String> redirect;

  // A fully-described module as a capnp message ready to hand to WorkerdApi::tryCompileModule.
  // When set, `redirect` is none.
  kj::Maybe<kj::Own<capnp::MallocMessageBuilder>> moduleMessage;
};

// Resolve a module specifier against the given root directory (the shared writable store captured
// at load time -- typically the parent Durable Object's writable "/"). FORK-ONLY (vfs-root-mount):
// resolution is rooted at "/", so resolved module specifiers and referrers are absolute paths like
// "/usr/lib/node_modules/x/..." (previously "/tmp/...").
//
// Returns kj::none when the specifier cannot be resolved (the registry then continues with its
// normal "not found" handling). `method` selects import vs require resolution semantics (file
// extensions, package.json field priority).
//
// Resolving against an explicit Directory (rather than VirtualFileSystem::current) is important:
// module resolution happens at worker startup, before any request injects the shared /tmp into the
// IoContext, so VirtualFileSystem::current(js) would see a private empty /tmp. The captured
// Directory is the source of truth and is valid at startup. Reads still require the isolate lock.
kj::Maybe<VfsResolveResult> resolveModuleFromVfs(jsg::Lock& js,
    Directory& tmpDir,
    kj::StringPtr specifier,
    kj::Maybe<kj::String> referrer,
    jsg::ModuleRegistry::ResolveMethod method,
    kj::Maybe<kj::StringPtr> rawSpecifier);

}  // namespace workerd::server
