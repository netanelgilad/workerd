#pragma once

#include <workerd/io/compatibility-date.capnp.h>
#include <workerd/io/compatibility-date.h>
#include <workerd/io/io-channels.h>
#include <workerd/io/io-own.h>
#include <workerd/io/worker.h>
#include <workerd/jsg/setup.h>

namespace workerd::api {

class Fetcher;
class DurableObjectClass;

// JS stub pointing to a remote Worker loaded using WorkerLoader. This is not a stub for a specific
// entrypoint, but instead the entire Worker, allowing the caller to call any entrypoint (and
// specify arbitrary props).
class WorkerStub: public jsg::Object {
 public:
  WorkerStub(IoOwn<WorkerStubChannel> channel): channel(kj::mv(channel)) {}

  struct EntrypointOptions {
    jsg::Optional<jsg::JsRef<jsg::JsObject>> props;
    jsg::Optional<ResourceLimits> limits;

    JSG_STRUCT(props, limits);
  };

  jsg::Ref<Fetcher> getEntrypoint(jsg::Lock& js,
      jsg::Optional<kj::Maybe<kj::String>> name,
      jsg::Optional<EntrypointOptions> options);
  jsg::Ref<DurableObjectClass> getDurableObjectClass(jsg::Lock& js,
      jsg::Optional<kj::Maybe<kj::String>> name,
      jsg::Optional<EntrypointOptions> options);

  JSG_RESOURCE_TYPE(WorkerStub, CompatibilityFlags::Reader flags) {
    JSG_METHOD(getEntrypoint);
    JSG_METHOD(getDurableObjectClass);

    JSG_TS_OVERRIDE({
      getEntrypoint<T extends Rpc.WorkerEntrypointBranded | undefined>(
          name?: string, options?: WorkerStubEntrypointOptions): Fetcher<T>;
      getDurableObjectClass<T extends Rpc.DurableObjectBranded | undefined>(
          name?: string, options?: WorkerStubEntrypointOptions): DurableObjectClass<T>;
    });
  }

 private:
  IoOwn<WorkerStubChannel> channel;
};

// JS interface for worker loader binding.
class WorkerLoader: public jsg::Object {
 public:
  // Create a WorkerLoader backed by the given I/O channel.
  //
  // `compatDateValidation` will differ between workerd vs. production.
  explicit WorkerLoader(uint channel, CompatibilityDateValidation compatDateValidation)
      : channel(channel),
        compatDateValidation(compatDateValidation) {}

  struct Module {
    // Exactly one must be filled in.
    jsg::Optional<kj::String> js;               // ES module
    jsg::Optional<kj::String> cjs;              // Common JS module
    jsg::Optional<kj::String> text;             // text blob, imports as a string
    jsg::Optional<kj::Array<const byte>> data;  // byte blob, imports as ArrayBuffer
    jsg::Optional<jsg::Value> json;             // arbitrary JS value, will be serialized to JSON
                                                // and then parsed again when imported
    jsg::Optional<kj::String> py;               // Python module
    jsg::Optional<kj::Array<const byte>> wasm;  // compiled WASM module

    JSG_STRUCT(js, cjs, text, data, json, py, wasm);

    // HACK: When we serialize the JSON in extractSource() we need to place the owned kj::String
    //   somewhere since Worker::Script::Source only gets a kj::StringPtr.
    kj::Maybe<kj::String> serializedJson;
  };

  struct WorkerCode {
    kj::String compatibilityDate;
    jsg::Optional<kj::Array<kj::String>> compatibilityFlags;
    jsg::Optional<bool> allowExperimental = false;

    jsg::Optional<ResourceLimits> limits;

    kj::String mainModule;

    // Modules are specified as an object mapping names to content. If the content is just a
    // string, an ES module is assumed. If it's an object, the type of module is determined
    // based on which property is set.
    jsg::Dict<kj::OneOf<Module, kj::String>> modules;

    // Any RPC-serializable value!
    jsg::Optional<jsg::JsRef<jsg::JsObject>> env;

    // `Fetcher` (e.g. service binding) representing the loaded worker's global outbound.
    //
    // If omitted, inherit the current worker's global outbound.
    //
    // If `null`, block the global outbound (all requests throw errors).
    jsg::Optional<kj::Maybe<jsg::Ref<Fetcher>>> globalOutbound;

    // Specify tail workers.
    jsg::Optional<kj::Array<jsg::Ref<Fetcher>>> tails;
    jsg::Optional<kj::Array<jsg::Ref<Fetcher>>> streamingTails;

    // FORK-ONLY (shared-tmp-vfs): OPT-IN. When true, this dynamically-loaded worker SHARES the
    // calling (parent) worker's writable /tmp virtual filesystem instead of getting its own
    // private one. This deliberately relaxes the per-isolate filesystem isolation and is intended
    // for trusted self-hosted deployments only. Defaults to false (isolated /tmp, upstream
    // behavior). SAME-THREAD ONLY -- the shared in-memory directory is not thread-safe; this is
    // safe in workerd because loaded isolates run on the parent's thread.
    jsg::Optional<bool> shareParentTmp = false;

    // FORK-ONLY (vfs-module-loading): OPT-IN. When true, this dynamically-loaded worker gets a
    // module fallback that resolves import/require specifiers by reading the worker's OWN virtual
    // filesystem (node-style: relative paths, bare specifiers via node_modules walking,
    // package.json main/module, file extensions, CJS vs ESM). Combined with `shareParentTmp: true`,
    // the child's /tmp IS the parent Durable Object's /tmp, so npm-installed packages under
    // /tmp/node_modules can be import()/require()d and RUN inside the child. Resolution is fully
    // synchronous and same-thread (the VFS is in-memory) -- no RPC, socket, or extra thread.
    // Defaults to false (no VFS module loading, upstream behavior).
    jsg::Optional<bool> vfsModuleFallback = false;

    // FORK-ONLY (drain-process): OPT-IN. When true, after this dynamically-loaded worker's RPC
    // entrypoint method resolves, the runtime drives the child's JavaScript event loop to
    // quiescence WITH the IoContext bound (see IoContext::runToQuiescence) before resolving the
    // RPC. This lets the child import a "bin" fire-and-forget -- e.g.
    // `await import('/tmp/usr/.../npm-cli.js')` after setting process.argv -- and have npm's
    // discarded top-level promise (`cli(process)`) run its async I/O continuations to completion
    // instead of advancing only in runImpl's post-scope SuppressIoContextScope pass (where the
    // first async-I/O hop throws "Disallowed operation called within global scope"). Effectively,
    // `await stub.getEntrypoint().run()` then resolves only when the child's "process" has exited.
    // Defaults to false (upstream behavior: the entrypoint promise resolves immediately).
    jsg::Optional<bool> drainProcess = false;

    // FORK-ONLY (native-spawn): OPT-IN. When true, this dynamically-loaded worker is granted an
    // implicit worker-loader channel of its own, making node:child_process.spawn() functional
    // inside it: spawn(file, args) launches ANOTHER drainProcess sub-isolate over the shared /tmp
    // and the ChildProcess 'exit' event fires when that sub-isolate reaches event-loop quiescence.
    // Spawned children are themselves created with allowSpawn, so "processes" can spawn
    // "processes" recursively with no userland plumbing. Defaults to false (upstream behavior:
    // child_process.spawn throws "not implemented").
    jsg::Optional<bool> allowSpawn = false;

    // TODO(someday): cache API outbound?

    JSG_STRUCT(compatibilityDate,
        compatibilityFlags,
        allowExperimental,
        limits,
        mainModule,
        modules,
        env,
        globalOutbound,
        tails,
        streamingTails,
        shareParentTmp,
        vfsModuleFallback,
        drainProcess,
        allowSpawn);
  };

  jsg::Ref<WorkerStub> get(
      jsg::Lock& js, kj::Maybe<kj::String> name, jsg::Function<jsg::Promise<WorkerCode>()> getCode);

  // Shortcut for `get(null, () => code)`.
  jsg::Ref<WorkerStub> load(jsg::Lock& js, WorkerCode code);

  JSG_RESOURCE_TYPE(WorkerLoader) {
    JSG_METHOD(get);
    JSG_METHOD(load);

    JSG_TS_ROOT();
  }

 private:
  uint channel;
  CompatibilityDateValidation compatDateValidation;

  static DynamicWorkerSource toDynamicWorkerSource(jsg::Lock& js,
      IoContext& ioctx,
      CompatibilityDateValidation compatDateValidation,
      WorkerCode code);

  static Worker::Script::Source extractSource(jsg::Lock& js, WorkerCode& code);
  static kj::Own<CompatibilityFlags::Reader> extractCompatFlags(
      jsg::Lock& js, WorkerCode& code, CompatibilityDateValidation compatDateValidation);

  kj::Promise<kj::Own<const Worker>> startWorker(
      Worker::Script::Source extractedSource, CompatibilityFlags::Reader compatibilityFlags);
};

#define EW_WORKER_LOADER_ISOLATE_TYPES                                                             \
  api::WorkerStub, api::WorkerStub::EntrypointOptions, api::WorkerLoader,                          \
      api::WorkerLoader::Module, api::WorkerLoader::WorkerCode, workerd::ResourceLimits

}  // namespace workerd::api
