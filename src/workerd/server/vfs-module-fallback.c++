#include <workerd/jsg/jsg.h>  // must precede vfs-module-fallback.h / modules.h for type-wrapper

#include "vfs-module-fallback.h"

#include <workerd/io/worker-fs.h>
#include <workerd/jsg/url.h>
#include <workerd/server/workerd.capnp.h>

#include <capnp/message.h>

#include <kj/debug.h>
#include <kj/map.h>
#include <kj/vector.h>

// FORK-ONLY (vfs-module-loading). See vfs-module-fallback.h for the design.
//
// Node-style resolution is performed entirely against the in-isolate VFS. Everything here is
// synchronous (the VFS is an in-memory tree behind the isolate lock) so it is safe to call from
// inside workerd's synchronous module-resolution path.

namespace workerd::server {
namespace {

// All VFS resolution is rooted at /tmp -- that is the directory shared with the parent DO.
constexpr kj::StringPtr kVfsRoot = "/tmp"_kj;

// ======================================================================================
// Small path helpers operating on absolute VFS paths (always start with "/tmp").

bool isBareSpecifier(kj::StringPtr spec) {
  return !spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("/") &&
      !spec.startsWith("#");
}

// Join a base directory (absolute, e.g. "/tmp/a/b") with a possibly-relative segment, collapsing
// "." and ".." segments. The result is always absolute. `rel` may itself be absolute, in which
// case `base` is ignored.
kj::String joinPath(kj::StringPtr base, kj::StringPtr rel) {
  kj::Vector<kj::String> parts;
  auto pushSegments = [&](kj::StringPtr p) {
    size_t start = 0;
    for (size_t i = 0; i <= p.size(); i++) {
      if (i == p.size() || p[i] == '/') {
        if (i > start) {
          auto seg = p.slice(start, i);
          if (seg == "."_kj) {
            // skip
          } else if (seg == ".."_kj) {
            if (parts.size() > 0) parts.removeLast();
          } else {
            parts.add(kj::str(seg));
          }
        }
        start = i + 1;
      }
    }
  };
  if (!rel.startsWith("/")) {
    pushSegments(base);
  }
  pushSegments(rel);
  auto joined = kj::strArray(parts, "/");
  return kj::str("/", joined);
}

kj::String dirnameOf(kj::StringPtr path) {
  KJ_IF_SOME(pos, path.findLast('/')) {
    if (pos == 0) return kj::str("/");
    return kj::str(path.slice(0, pos));
  }
  return kj::str(path);
}

kj::String extnameOf(kj::StringPtr path) {
  KJ_IF_SOME(slash, path.findLast('/')) {
    auto base = path.slice(slash + 1);
    KJ_IF_SOME(dot, base.findLast('.')) {
      if (dot > 0) return kj::str(base.slice(dot));
    }
    return kj::str();
  }
  KJ_IF_SOME(dot, path.findLast('.')) {
    if (dot > 0) return kj::str(path.slice(dot));
  }
  return kj::str();
}

// ======================================================================================
// VFS access. We resolve directly against the captured /tmp Directory (NOT
// VirtualFileSystem::current(js), which at module-resolution time sees a private empty /tmp).
//
// All paths handled here are absolute like "/tmp/...". We convert to a path relative to the /tmp
// directory before calling Directory::tryOpen/stat.

// Convert an absolute "/tmp/..." path into a kj::Path relative to the /tmp directory. Returns
// kj::none if the path is not under /tmp.
kj::Maybe<kj::Path> toTmpRelativePath(kj::StringPtr absPath) {
  if (absPath == kVfsRoot) {
    return kj::Path(nullptr);
  }
  auto prefix = kj::str(kVfsRoot, "/");
  if (!absPath.startsWith(prefix)) {
    return kj::none;
  }
  auto rel = absPath.slice(prefix.size());
  kj::Path root{};
  return root.eval(rel);
}

kj::Maybe<Stat> vfsStat(jsg::Lock& js, Directory& tmpDir, kj::StringPtr absPath) {
  KJ_IF_SOME(rel, toTmpRelativePath(absPath)) {
    KJ_IF_SOME(res, tmpDir.stat(js, rel)) {
      KJ_IF_SOME(stat, res.tryGet<Stat>()) {
        return stat;
      }
    }
  }
  return kj::none;
}

bool vfsIsFile(jsg::Lock& js, Directory& tmpDir, kj::StringPtr absPath) {
  KJ_IF_SOME(stat, vfsStat(js, tmpDir, absPath)) {
    return stat.type == FsType::FILE;
  }
  return false;
}

bool vfsIsDir(jsg::Lock& js, Directory& tmpDir, kj::StringPtr absPath) {
  KJ_IF_SOME(stat, vfsStat(js, tmpDir, absPath)) {
    return stat.type == FsType::DIRECTORY;
  }
  return false;
}

kj::Maybe<kj::String> vfsReadText(jsg::Lock& js, Directory& tmpDir, kj::StringPtr absPath) {
  KJ_IF_SOME(rel, toTmpRelativePath(absPath)) {
    KJ_IF_SOME(node, tmpDir.tryOpen(js, rel, Directory::OpenOptions{.followLinks = true})) {
      KJ_IF_SOME(file, node.tryGet<kj::Rc<File>>()) {
        auto result = file->readAllText(js);
        KJ_IF_SOME(str, result.tryGet<jsg::JsString>()) {
          return str.toString(js);
        }
      }
    }
  }
  return kj::none;
}

// ======================================================================================
// node-style resolution

const kj::StringPtr kExtensionsImport[] = {".js"_kj, ".mjs"_kj, ".cjs"_kj, ".json"_kj};
const kj::StringPtr kExtensionsRequire[] = {".js"_kj, ".cjs"_kj, ".json"_kj};

// Try `path`, then `path.<ext>` for each candidate extension. Returns the first file that exists.
kj::Maybe<kj::String> resolveAsFile(
    jsg::Lock& js, Directory& tmpDir, kj::StringPtr path, jsg::ModuleRegistry::ResolveMethod method) {
  if (vfsIsFile(js, tmpDir, path)) {
    return kj::str(path);
  }
  auto exts = method == jsg::ModuleRegistry::ResolveMethod::REQUIRE
      ? kj::arrayPtr(kExtensionsRequire, kj::size(kExtensionsRequire))
      : kj::arrayPtr(kExtensionsImport, kj::size(kExtensionsImport));
  for (auto ext: exts) {
    auto candidate = kj::str(path, ext);
    if (vfsIsFile(js, tmpDir, candidate)) {
      return kj::mv(candidate);
    }
  }
  return kj::none;
}

// Read a "main"-style field from a package.json. Tries `exports` (".") for import, then `module`
// then `main`. Returns the raw field value (a relative path) or kj::none.
kj::Maybe<kj::String> readPackageEntry(
    jsg::Lock& js, kj::StringPtr pkgJsonText, jsg::ModuleRegistry::ResolveMethod method);

kj::Maybe<kj::String> resolveAsDirectory(
    jsg::Lock& js, Directory& tmpDir, kj::StringPtr dir, jsg::ModuleRegistry::ResolveMethod method) {
  // package.json main/module/exports
  auto pkgJsonPath = kj::str(dir, "/package.json");
  KJ_IF_SOME(pkgText, vfsReadText(js, tmpDir, pkgJsonPath)) {
    KJ_IF_SOME(entry, readPackageEntry(js, pkgText, method)) {
      auto target = joinPath(dir, entry);
      KJ_IF_SOME(file, resolveAsFile(js, tmpDir, target, method)) {
        return kj::mv(file);
      }
      // entry may point at a directory containing an index.
      auto indexInTarget = kj::str(target, "/index");
      KJ_IF_SOME(file, resolveAsFile(js, tmpDir, indexInTarget, method)) {
        return kj::mv(file);
      }
    }
  }
  // Fallback to index.*
  auto indexPath = kj::str(dir, "/index");
  return resolveAsFile(js, tmpDir, indexPath, method);
}

// Walk node_modules up the directory tree starting at `fromDir`, looking for the bare specifier.
kj::Maybe<kj::String> resolveBare(jsg::Lock& js,
    Directory& tmpDir,
    kj::StringPtr fromDir,
    kj::StringPtr spec,
    jsg::ModuleRegistry::ResolveMethod method) {
  auto dir = kj::str(fromDir);
  while (true) {
    // Skip a node_modules dir nested inside another node_modules path component duplication is
    // fine; node walks every ancestor including ones already under node_modules.
    auto candidateBase = kj::str(dir, "/node_modules/", spec);
    // 1) as a file (with extensions)
    KJ_IF_SOME(file, resolveAsFile(js, tmpDir, candidateBase, method)) {
      return kj::mv(file);
    }
    // 2) as a directory (package.json / index)
    if (vfsIsDir(js, tmpDir, candidateBase)) {
      KJ_IF_SOME(file, resolveAsDirectory(js, tmpDir, candidateBase, method)) {
        return kj::mv(file);
      }
    }
    // Ascend.
    if (dir == kVfsRoot || dir == "/"_kj || dir.size() <= kVfsRoot.size()) {
      break;
    }
    auto parent = dirnameOf(dir);
    if (parent == dir) break;
    dir = kj::mv(parent);
  }
  return kj::none;
}

// Resolve `rawSpec` (the user-written specifier) relative to `referrerPath` (absolute VFS path of
// the importing module, or kj::none if the importer is not in the VFS). Returns the absolute VFS
// path of the resolved module file.
kj::Maybe<kj::String> nodeResolve(jsg::Lock& js,
    Directory& tmpDir,
    kj::StringPtr rawSpec,
    kj::Maybe<kj::StringPtr> referrerPath,
    jsg::ModuleRegistry::ResolveMethod method) {
  // Base directory for relative resolution / node_modules walking.
  kj::String baseDir;
  KJ_IF_SOME(ref, referrerPath) {
    baseDir = dirnameOf(ref);
  } else {
    baseDir = kj::str(kVfsRoot);
  }

  if (rawSpec.startsWith("/")) {
    // Absolute path -- only honor it if it's under the VFS root.
    if (!(rawSpec == kVfsRoot || rawSpec.startsWith(kj::str(kVfsRoot, "/")))) {
      return kj::none;
    }
    KJ_IF_SOME(file, resolveAsFile(js, tmpDir, rawSpec, method)) {
      return kj::mv(file);
    }
    if (vfsIsDir(js, tmpDir, rawSpec)) {
      return resolveAsDirectory(js, tmpDir, rawSpec, method);
    }
    return kj::none;
  }

  if (rawSpec.startsWith("./") || rawSpec.startsWith("../") || rawSpec == "."_kj ||
      rawSpec == ".."_kj) {
    auto target = joinPath(baseDir, rawSpec);
    KJ_IF_SOME(file, resolveAsFile(js, tmpDir, target, method)) {
      return kj::mv(file);
    }
    if (vfsIsDir(js, tmpDir, target)) {
      return resolveAsDirectory(js, tmpDir, target, method);
    }
    return kj::none;
  }

  // Bare specifier (incl. scoped packages and subpaths). Walk node_modules.
  return resolveBare(js, tmpDir, baseDir, rawSpec, method);
}

// ======================================================================================
// Source classification + named-export discovery.

// Walk up from the module file looking for the nearest package.json `type`.
bool packageTypeIsModule(jsg::Lock& js, Directory& tmpDir, kj::StringPtr filePath) {
  auto dir = dirnameOf(filePath);
  while (true) {
    auto pkgJsonPath = kj::str(dir, "/package.json");
    KJ_IF_SOME(text, vfsReadText(js, tmpDir, pkgJsonPath)) {
      // crude scan for "type":"module"
      return text.contains("\"type\""_kj) && text.contains("\"module\""_kj) &&
          // ensure the "module" value is associated with "type" (best-effort)
          [&]() {
            KJ_IF_SOME(tpos, text.find("\"type\""_kj)) {
              auto after = text.slice(tpos);
              KJ_IF_SOME(mpos, after.find("\"module\""_kj)) {
                // "module" appears shortly after "type"
                return mpos < 32;
              }
            }
            return false;
          }();
    }
    if (dir == kVfsRoot || dir == "/"_kj || dir.size() <= kVfsRoot.size()) break;
    auto parent = dirnameOf(dir);
    if (parent == dir) break;
    dir = kj::mv(parent);
  }
  return false;
}

enum class ModFormat { ESM, CJS, JSON };

ModFormat classify(jsg::Lock& js, Directory& tmpDir, kj::StringPtr filePath, kj::StringPtr src) {
  auto ext = extnameOf(filePath);
  if (ext == ".json"_kj) return ModFormat::JSON;
  if (ext == ".mjs"_kj) return ModFormat::ESM;
  if (ext == ".cjs"_kj) return ModFormat::CJS;
  if (packageTypeIsModule(js, tmpDir, filePath)) return ModFormat::ESM;
  // Heuristic: ESM if it has top-level import/export and no obvious CommonJS exports.
  bool looksEsm = src.contains("export "_kj) || src.contains("export{"_kj) ||
      src.contains("export*"_kj) || src.contains("import "_kj) || src.contains("import{"_kj);
  bool looksCjs = src.contains("module.exports"_kj) || src.contains("exports."_kj) ||
      src.contains("require("_kj);
  if (looksEsm && !looksCjs) return ModFormat::ESM;
  return ModFormat::CJS;
}

// Best-effort extraction of CommonJS named exports via simple textual scanning. This covers the
// common cases (exports.foo = ..., Object.defineProperty(exports, "foo", ...),
// module.exports = { foo, bar }). It is intentionally conservative: missing a named export only
// means `import { foo } from "x"` won't bind, while the default/namespace import still works.
kj::Array<kj::String> discoverCjsNamedExports(kj::StringPtr src) {
  kj::Vector<kj::String> names;
  kj::HashSet<kj::String> seen;
  auto addName = [&](kj::ArrayPtr<const char> raw) {
    if (raw.size() == 0) return;
    // Valid identifier check.
    char c0 = raw[0];
    if (!((c0 >= 'a' && c0 <= 'z') || (c0 >= 'A' && c0 <= 'Z') || c0 == '_' || c0 == '$')) return;
    for (char c: raw) {
      if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
              c == '_' || c == '$')) {
        return;
      }
    }
    kj::String n = kj::str(raw);
    if (n == "default"_kj) return;
    if (seen.contains(n)) return;
    seen.insert(kj::str(n));
    names.add(kj::mv(n));
  };

  // Scan for `exports.<name>` patterns.
  kj::StringPtr needle = "exports."_kj;
  size_t pos = 0;
  while (pos < src.size()) {
    KJ_IF_SOME(found, src.slice(pos).find(needle)) {
      size_t start = pos + found + needle.size();
      size_t end = start;
      while (end < src.size()) {
        char c = src[end];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
            c == '_' || c == '$') {
          end++;
        } else {
          break;
        }
      }
      if (end > start) {
        addName(src.slice(start, end));
      }
      pos = end > pos ? end : pos + needle.size();
    } else {
      break;
    }
  }
  return KJ_MAP(n, names) { return kj::mv(n); };
}

kj::Maybe<kj::String> readPackageEntry(
    jsg::Lock& js, kj::StringPtr pkgJsonText, jsg::ModuleRegistry::ResolveMethod method) {
  // We avoid pulling in a JSON parser; do a minimal field extraction. Priority differs by method:
  //   import:  module, main
  //   require: main
  // (We intentionally do not implement full conditional `exports` maps here; main/module covers
  //  the overwhelming majority of npm packages, including the validation targets.)
  auto extractStringField = [&](kj::StringPtr field) -> kj::Maybe<kj::String> {
    auto key = kj::str("\"", field, "\"");
    KJ_IF_SOME(kpos, pkgJsonText.find(key)) {
      auto after = pkgJsonText.slice(kpos + key.size());
      // find ':'
      KJ_IF_SOME(colon, after.find(":"_kj)) {
        auto afterColon = after.slice(colon + 1);
        // find opening quote
        KJ_IF_SOME(q1, afterColon.find("\""_kj)) {
          auto afterQ1 = afterColon.slice(q1 + 1);
          KJ_IF_SOME(q2, afterQ1.find("\""_kj)) {
            return kj::str(afterQ1.slice(0, q2));
          }
        }
      }
    }
    return kj::none;
  };

  if (method == jsg::ModuleRegistry::ResolveMethod::IMPORT) {
    KJ_IF_SOME(m, extractStringField("module"_kj)) {
      return kj::mv(m);
    }
  }
  return extractStringField("main"_kj);
}

}  // namespace

kj::Maybe<VfsResolveResult> resolveModuleFromVfs(jsg::Lock& js,
    Directory& tmpDir,
    kj::StringPtr specifier,
    kj::Maybe<kj::String> referrer,
    jsg::ModuleRegistry::ResolveMethod method,
    kj::Maybe<kj::StringPtr> rawSpecifier) {
  // The legacy registry passes `specifier` as a workerd module path (leading '/'); `rawSpecifier`
  // is what the user actually wrote. We resolve off rawSpecifier + referrer when available.
  kj::String rawSpec = kj::str(rawSpecifier.orDefault(specifier));

  // Skip node:/cloudflare:/workerd: builtins -- workerd resolves these natively; we must not
  // shadow them from the VFS.
  if (rawSpec.startsWith("node:") || rawSpec.startsWith("cloudflare:") ||
      rawSpec.startsWith("workerd:")) {
    return kj::none;
  }

  // Determine the referrer's absolute VFS path, if it is in the VFS. The registry's referrer is a
  // workerd path; for VFS-served modules it will be an absolute path under /tmp.
  kj::Maybe<kj::String> referrerVfsPath;
  KJ_IF_SOME(ref, referrer) {
    // The referrer arrives as a workerd module specifier. It may be:
    //   - a file:// URL,
    //   - a registry ROOT-RELATIVE path like "tmp/node_modules/x/index.js" (no leading slash),
    //   - or an absolute "/tmp/..." path.
    // Normalize all of these to an absolute "/tmp/..." path (our internal form).
    kj::String r = kj::str(ref);
    if (r.startsWith("file://")) {
      r = kj::str(r.slice(7));
    }
    if (!r.startsWith("/")) {
      r = kj::str("/", r);
    }
    // Only treat as a VFS referrer if it is under the VFS root.
    if (r == kVfsRoot || r.startsWith(kj::str(kVfsRoot, "/"))) {
      referrerVfsPath = kj::mv(r);
    }
  }

  // For a bare specifier with no VFS referrer, root the node_modules walk at /tmp.
  // For relative specifiers with no VFS referrer, there's nothing to resolve against -> bail.
  if (referrerVfsPath == kj::none && !isBareSpecifier(rawSpec) && !rawSpec.startsWith("/")) {
    return kj::none;
  }

  kj::Maybe<kj::StringPtr> refPtr;
  KJ_IF_SOME(rv, referrerVfsPath) {
    refPtr = rv.asPtr();
  }

  KJ_IF_SOME(resolvedPath, nodeResolve(js, tmpDir, rawSpec, refPtr, method)) {
    // `resolvedPath` is an absolute path like "/tmp/node_modules/adder/index.js". The legacy module
    // registry, however, identifies modules by ROOT-RELATIVE kj::Path strings (no leading slash):
    // e.g. it computes the lookup specifier via `referrerPath.parent().eval("adder")` ==
    // "tmp/adder" and stores compiled modules / module names in that form. We therefore normalize
    // to the registry form (drop the leading slash) before comparing to `specifier`, before
    // emitting a redirect, and as the compiled module's name -- otherwise the registry and our
    // resolver disagree on the canonical name and loop / mis-parse the name as an absolute path.
    kj::String registryPath =
        resolvedPath.startsWith("/") ? kj::str(resolvedPath.slice(1)) : kj::str(resolvedPath);

    // Normalize the incoming specifier to registry form (no leading slash) for comparison: ESM
    // resolution hands us "/greet" while require hands us "tmp/adder".
    kj::StringPtr specifierNorm = specifier.startsWith("/") ? specifier.slice(1) : specifier;

    // If the registry asked us about a different specifier string than the resolved path, issue a
    // redirect so the registry re-enters with the canonical path. This mirrors the HTTP fallback
    // service's 301 behavior and keeps referrers consistent for transitive imports.
    //
    // IMPORTANT: the registry resolves the redirect via `specifier.parent().eval(redirect)`. A
    // ROOT-RELATIVE redirect (e.g. "tmp/node_modules/adder/index.js") would be wrongly joined onto
    // the specifier's parent ("tmp" -> "tmp/tmp/..."), causing an infinite redirect loop. We must
    // therefore return an ABSOLUTE redirect with a leading slash: PathPtr::eval drops the parent
    // parts when the argument starts with "/", landing exactly on the resolved path. (The compiled
    // module NAME below still uses the registry-form path, since module names are parsed as
    // root-relative kj::Path strings which reject a leading slash.)
    if (registryPath != specifierNorm) {
      return VfsResolveResult{
        .redirect = kj::mv(resolvedPath), .moduleMessage = kj::none};
    }

    // specifier == registryPath: read + describe the module. Compilation happens in the caller.
    KJ_IF_SOME(src, vfsReadText(js, tmpDir, resolvedPath)) {
      auto format = classify(js, tmpDir, resolvedPath, src);

      auto message = kj::heap<capnp::MallocMessageBuilder>();
      auto module = message->initRoot<config::Worker::Module>();
      module.setName(registryPath);

      switch (format) {
        case ModFormat::ESM: {
          module.setEsModule(src);
          break;
        }
        case ModFormat::JSON: {
          module.setJson(src);
          break;
        }
        case ModFormat::CJS: {
          module.setCommonJsModule(src);
          auto named = discoverCjsNamedExports(src);
          if (named.size() > 0) {
            auto list = module.initNamedExports(named.size());
            for (auto i: kj::indices(named)) {
              list.set(i, named[i]);
            }
          }
          break;
        }
      }

      return VfsResolveResult{.redirect = kj::none, .moduleMessage = kj::mv(message)};
    }
  }

  return kj::none;
}

}  // namespace workerd::server
