#include "commonjs.h"

#include <workerd/io/features.h>
#include <workerd/jsg/jsg.h>
#include <workerd/jsg/modules-new.h>
#include <workerd/jsg/resource.h>

namespace workerd::api {

CommonJsModuleContext::CommonJsModuleContext(jsg::Lock& js, kj::Path path)
    : module(js.alloc<CommonJsModuleObject>(js, path.toString(true))),
      pathOrSpecifier(kj::mv(path)),
      exports(js, module->getExports(js)) {}

CommonJsModuleContext::CommonJsModuleContext(jsg::Lock& js, const jsg::Url& specifier)
    : module(js.alloc<CommonJsModuleObject>(js, kj::str(specifier.getHref()))),
      pathOrSpecifier(specifier.clone()),
      exports(js, module->getExports(js)) {}

jsg::JsValue CommonJsModuleContext::require(jsg::Lock& js, kj::String specifier) {
  if (isNodeJsCompatEnabled(js)) {
    KJ_IF_SOME(nodeSpec, jsg::checkNodeSpecifier(specifier)) {
      specifier = kj::mv(nodeSpec);
    }
  }

  if (FeatureFlags::get(js).getNewModuleRegistry()) {
    auto& referrer = KJ_ASSERT_NONNULL(pathOrSpecifier.tryGet<jsg::Url>());
    KJ_IF_SOME(ns,
        jsg::modules::ModuleRegistry::tryResolveModuleNamespace(js, specifier,
            jsg::modules::ResolveContext::Type::BUNDLE,
            jsg::modules::ResolveContext::Source::REQUIRE, referrer,
            jsg::modules::UnwrapDefault::YES)) {
      return ns;
    }
    JSG_FAIL_REQUIRE(Error, kj::str("Module not found: ", specifier));
  }

  auto& path = KJ_ASSERT_NONNULL(pathOrSpecifier.tryGet<kj::Path>());

  auto modulesForResolveCallback = jsg::getModulesForResolveCallback(js.v8Isolate);
  KJ_REQUIRE(modulesForResolveCallback != nullptr, "didn't expect resolveCallback() now");

  auto requireOptions = jsg::ModuleRegistry::RequireImplOptions::DEFAULT;
  if (FeatureFlags::get(js).getExportCommonJsDefaultNamespace()) {
    requireOptions = jsg::ModuleRegistry::RequireImplOptions::EXPORT_DEFAULT;
  }

  // FORK-ONLY (vfs-module-loading): mirror the ESM resolveCallback's node:process redirect for
  // CJS require(). `process` is the only node: builtin with no top-level `node:process` module --
  // it lives as the internal module node-internal:{public,legacy}_process, and every other entry
  // point (static import in modules.c++, dynamic import in modules.h) special-cases the redirect.
  // The generic CJS resolve below never finds a `node:process` builtin, so without this it throws
  // `No such module "node:process".`, which breaks real npm (npm-install-checks/lib/current-env.js
  // does `require('process')`, normalized to `node:process` by checkNodeSpecifier above). All other
  // node: builtins (fs, os, v8, ...) resolve identically for import and require via their real
  // builtin modules; process is the sole gap.
  if (specifier == "node:process") {
    auto processSpec = kj::Path::parse(jsg::isNodeJsProcessV2Enabled(js)
            ? "node-internal:public_process"_kj
            : "node-internal:legacy_process"_kj);
    auto& info = JSG_REQUIRE_NONNULL(
        modulesForResolveCallback->resolve(js, processSpec, kj::none,
            jsg::ModuleRegistry::ResolveOption::INTERNAL_ONLY,
            jsg::ModuleRegistry::ResolveMethod::REQUIRE, specifier.asPtr()),
        Error, "No such module \"", specifier, "\".");
    return jsg::ModuleRegistry::requireImpl(js, info, requireOptions);
  }

  kj::Path targetPath = ([&] {
    // If the specifier begins with one of our known prefixes, let's not resolve
    // it against the referrer.
    if (specifier.startsWith("node:") || specifier.startsWith("cloudflare:") ||
        specifier.startsWith("workerd:")) {
      return kj::Path::parse(specifier);
    }
    return path.parent().eval(specifier);
  })();

  // require() is only exposed to worker bundle modules so the resolve here is only
  // permitted to require worker bundle or built-in modules. Internal modules are
  // excluded.
  auto& info =
      JSG_REQUIRE_NONNULL(modulesForResolveCallback->resolve(js, targetPath, path,
                              jsg::ModuleRegistry::ResolveOption::DEFAULT,
                              jsg::ModuleRegistry::ResolveMethod::REQUIRE, specifier.asPtr()),
          Error, "No such module \"", targetPath.toString(), "\".");
  // Adding imported from suffix here not necessary like it is for resolveCallback, since we have a
  // js stack that will include the parent module's name and location of the failed require().

  auto options = jsg::ModuleRegistry::RequireImplOptions::DEFAULT;
  if (FeatureFlags::get(js).getExportCommonJsDefaultNamespace()) {
    options = jsg::ModuleRegistry::RequireImplOptions::EXPORT_DEFAULT;
  }

  return jsg::ModuleRegistry::requireImpl(js, info, options);
}

kj::String CommonJsModuleContext::requireResolve(jsg::Lock& js, kj::String specifier) {
  // FORK-ONLY (require-resolve). Node returns builtin specifiers untouched from
  // require.resolve() ('fs' -> 'fs', 'node:fs' -> 'node:fs'); match that before any resolution.
  if (specifier.startsWith("node:") || specifier.startsWith("cloudflare:") ||
      specifier.startsWith("workerd:")) {
    return kj::mv(specifier);
  }
  if (isNodeJsCompatEnabled(js) && jsg::checkNodeSpecifier(specifier) != kj::none) {
    return kj::mv(specifier);
  }

  if (FeatureFlags::get(js).getNewModuleRegistry()) {
    // Not implemented for the new module registry; the fork's VFS-loaded Worker-Loader children
    // (the consumers of require.resolve) run on the original registry.
    JSG_FAIL_REQUIRE(Error, "require.resolve() is not implemented with the new module registry");
  }

  auto& path = KJ_ASSERT_NONNULL(pathOrSpecifier.tryGet<kj::Path>());

  auto modulesForResolveCallback = jsg::getModulesForResolveCallback(js.v8Isolate);
  KJ_REQUIRE(modulesForResolveCallback != nullptr, "didn't expect resolveCallback() now");

  // Same referrer-relative evaluation require() performs (relative './x', '../x', absolute
  // '/x', and bare specifiers -- the raw specifier travels along so the VFS fallback can do
  // node_modules walking for bare names).
  kj::Path targetPath = path.parent().eval(specifier);

  return JSG_REQUIRE_NONNULL(
      modulesForResolveCallback->resolveRequirePath(js, targetPath, path, specifier.asPtr()),
      Error, "Cannot find module '", specifier, "'");
}

jsg::JsValue CommonJsModuleContext::getRequire(jsg::Lock& js) {
  // FORK-ONLY (require-resolve): build the per-module `require` function object, carrying a
  // `resolve` property like Node's. JSG caches the result on the instance (lazy property), so
  // this runs at most once per module.
  auto requireFn = js.wrapReturningFunction(js.v8Context(),
      [self = JSG_THIS](jsg::Lock& js,
          const v8::FunctionCallbackInfo<v8::Value>& args) mutable -> v8::Local<v8::Value> {
    return self->require(js, js.toString(args[0]));
  });
  auto resolveFn = js.wrapReturningFunction(js.v8Context(),
      [self = JSG_THIS](jsg::Lock& js,
          const v8::FunctionCallbackInfo<v8::Value>& args) mutable -> v8::Local<v8::Value> {
    return js.str(self->requireResolve(js, js.toString(args[0])));
  });
  auto obj = jsg::JsObject(requireFn);
  obj.set(js, "resolve", jsg::JsValue(resolveFn));
  return jsg::JsValue(requireFn);
}

void CommonJsModuleContext::visitForMemoryInfo(jsg::MemoryTracker& tracker) const {
  tracker.trackField("exports", exports);
  KJ_SWITCH_ONEOF(pathOrSpecifier) {
    KJ_CASE_ONEOF(path, kj::Path) {
      tracker.trackFieldWithSize("path", path.size());
    }
    KJ_CASE_ONEOF(specifier, jsg::Url) {
      tracker.trackField("specifier", specifier);
    }
  }
}

kj::String CommonJsModuleContext::getFilename() const {
  KJ_SWITCH_ONEOF(pathOrSpecifier) {
    KJ_CASE_ONEOF(path, kj::Path) {
      return path.toString(true);
    }
    KJ_CASE_ONEOF(specifier, jsg::Url) {
      // The specifier is a URL. We want to parse it as a path and
      // return just the filename portion.
      // TODO(soon): kj::Path::parse() requires a kj::StringPtr but
      // the path name here is a kj::ArrayPtr<const char>. We can
      // avoid an extraneous copy here by updating kj::Path::parse
      // to also accept a kj::ArrayPtr<const char>.
      auto path = kj::str(specifier.getPathname().slice(1));
      auto filename = kj::Path::parse(path).basename();
      return filename.toString(false);
    }
  }
  KJ_UNREACHABLE;
}

kj::String CommonJsModuleContext::getDirname() const {
  KJ_SWITCH_ONEOF(pathOrSpecifier) {
    KJ_CASE_ONEOF(path, kj::Path) {
      return path.parent().toString(true);
    }
    KJ_CASE_ONEOF(specifier, jsg::Url) {
      // The specifier is a URL. We want to parse it as a path and
      // return just the directory portion.
      auto path = kj::str(specifier.getPathname().slice(1));
      auto pathObj = kj::Path::parse(path);
      return pathObj.parent().toString(true);
    }
  }
  KJ_UNREACHABLE;
}

jsg::Ref<CommonJsModuleObject> CommonJsModuleContext::getModule(jsg::Lock& js) {
  return module.addRef();
}

jsg::JsValue CommonJsModuleContext::getExports(jsg::Lock& js) const {
  return exports.getHandle(js);
}
void CommonJsModuleContext::setExports(jsg::Lock& js, jsg::JsValue value) {
  exports = jsg::JsRef(js, value);
}

CommonJsModuleObject::CommonJsModuleObject(jsg::Lock& js, kj::String path)
    : exports(js, js.obj()),
      path(kj::mv(path)) {}

jsg::JsValue CommonJsModuleObject::getExports(jsg::Lock& js) const {
  return exports.getHandle(js);
}
void CommonJsModuleObject::setExports(jsg::Lock& js, jsg::JsValue value) {
  exports = jsg::JsRef(js, value);
}

kj::StringPtr CommonJsModuleObject::getPath() const {
  return path;
}

void CommonJsModuleObject::visitForMemoryInfo(jsg::MemoryTracker& tracker) const {
  tracker.trackField("exports", exports);
  tracker.trackField("path", path);
}
}  // namespace workerd::api
