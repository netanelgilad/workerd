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
// Minimal JSON parser. We only need it to navigate package.json `exports` / `imports` maps
// (objects, strings, arrays, null) -- enough to implement Node's PACKAGE_EXPORTS_RESOLVE without
// dragging a full JSON library into this translation unit. Numbers/booleans are parsed but unused.

struct JsonValue;
using JsonObject = kj::Vector<kj::Tuple<kj::String, kj::Own<JsonValue>>>;
using JsonArray = kj::Vector<kj::Own<JsonValue>>;

struct JsonValue {
  enum class Type { NUL, BOOL, NUMBER, STRING, ARRAY, OBJECT };
  Type type = Type::NUL;
  kj::String str;          // STRING
  JsonArray arr;           // ARRAY
  JsonObject obj;          // OBJECT (insertion-ordered: condition order matters in `exports`)

  // Lookup a key in an OBJECT, preserving insertion order semantics for callers that iterate.
  kj::Maybe<JsonValue&> get(kj::StringPtr key) {
    if (type != Type::OBJECT) return kj::none;
    for (auto& e: obj) {
      if (kj::get<0>(e) == key) return *kj::get<1>(e);
    }
    return kj::none;
  }
};

class JsonParser {
 public:
  explicit JsonParser(kj::StringPtr text): s(text), pos(0) {}

  kj::Maybe<kj::Own<JsonValue>> parse() {
    skipWs();
    auto v = parseValue();
    return v;
  }

 private:
  kj::StringPtr s;
  size_t pos;

  void skipWs() {
    while (pos < s.size()) {
      char c = s[pos];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
        pos++;
      } else {
        break;
      }
    }
  }

  kj::Maybe<kj::Own<JsonValue>> parseValue() {
    skipWs();
    if (pos >= s.size()) return kj::none;
    char c = s[pos];
    if (c == '{') return parseObject();
    if (c == '[') return parseArray();
    if (c == '"') return parseString();
    if (c == 't' || c == 'f') return parseBool();
    if (c == 'n') return parseNull();
    return parseNumber();
  }

  kj::Maybe<kj::Own<JsonValue>> parseString() {
    KJ_IF_SOME(str, parseRawString()) {
      auto v = kj::heap<JsonValue>();
      v->type = JsonValue::Type::STRING;
      v->str = kj::mv(str);
      return kj::mv(v);
    }
    return kj::none;
  }

  // Parse a JSON string literal (assumes current char is the opening quote). Handles the escapes
  // that actually appear in package.json export maps.
  kj::Maybe<kj::String> parseRawString() {
    if (pos >= s.size() || s[pos] != '"') return kj::none;
    pos++;  // opening quote
    kj::Vector<char> out;
    while (pos < s.size()) {
      char c = s[pos++];
      if (c == '"') {
        out.add('\0');
        return kj::String(out.releaseAsArray());
      }
      if (c == '\\' && pos < s.size()) {
        char e = s[pos++];
        switch (e) {
          case 'n': out.add('\n'); break;
          case 't': out.add('\t'); break;
          case 'r': out.add('\r'); break;
          case 'b': out.add('\b'); break;
          case 'f': out.add('\f'); break;
          case '/': out.add('/'); break;
          case '\\': out.add('\\'); break;
          case '"': out.add('"'); break;
          case 'u': {
            // Skip 4 hex digits; emit '?' (export maps never use non-ASCII for paths).
            for (int i = 0; i < 4 && pos < s.size(); i++) pos++;
            out.add('?');
            break;
          }
          default: out.add(e); break;
        }
      } else {
        out.add(c);
      }
    }
    return kj::none;  // unterminated
  }

  kj::Maybe<kj::Own<JsonValue>> parseObject() {
    pos++;  // '{'
    auto v = kj::heap<JsonValue>();
    v->type = JsonValue::Type::OBJECT;
    skipWs();
    if (pos < s.size() && s[pos] == '}') {
      pos++;
      return kj::mv(v);
    }
    while (pos < s.size()) {
      skipWs();
      KJ_IF_SOME(key, parseRawString()) {
        skipWs();
        if (pos >= s.size() || s[pos] != ':') return kj::none;
        pos++;  // ':'
        KJ_IF_SOME(val, parseValue()) {
          v->obj.add(kj::tuple(kj::mv(key), kj::mv(val)));
        } else {
          return kj::none;
        }
      } else {
        return kj::none;
      }
      skipWs();
      if (pos >= s.size()) return kj::none;
      if (s[pos] == ',') {
        pos++;
        continue;
      }
      if (s[pos] == '}') {
        pos++;
        return kj::mv(v);
      }
      return kj::none;
    }
    return kj::none;
  }

  kj::Maybe<kj::Own<JsonValue>> parseArray() {
    pos++;  // '['
    auto v = kj::heap<JsonValue>();
    v->type = JsonValue::Type::ARRAY;
    skipWs();
    if (pos < s.size() && s[pos] == ']') {
      pos++;
      return kj::mv(v);
    }
    while (pos < s.size()) {
      KJ_IF_SOME(val, parseValue()) {
        v->arr.add(kj::mv(val));
      } else {
        return kj::none;
      }
      skipWs();
      if (pos >= s.size()) return kj::none;
      if (s[pos] == ',') {
        pos++;
        continue;
      }
      if (s[pos] == ']') {
        pos++;
        return kj::mv(v);
      }
      return kj::none;
    }
    return kj::none;
  }

  kj::Maybe<kj::Own<JsonValue>> parseBool() {
    auto v = kj::heap<JsonValue>();
    v->type = JsonValue::Type::BOOL;
    if (s.slice(pos).startsWith("true"_kj)) {
      pos += 4;
      return kj::mv(v);
    }
    if (s.slice(pos).startsWith("false"_kj)) {
      pos += 5;
      return kj::mv(v);
    }
    return kj::none;
  }

  kj::Maybe<kj::Own<JsonValue>> parseNull() {
    if (s.slice(pos).startsWith("null"_kj)) {
      pos += 4;
      auto v = kj::heap<JsonValue>();
      v->type = JsonValue::Type::NUL;
      return kj::mv(v);
    }
    return kj::none;
  }

  kj::Maybe<kj::Own<JsonValue>> parseNumber() {
    size_t start = pos;
    while (pos < s.size()) {
      char c = s[pos];
      if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') {
        pos++;
      } else {
        break;
      }
    }
    if (pos == start) return kj::none;
    auto v = kj::heap<JsonValue>();
    v->type = JsonValue::Type::NUMBER;
    v->str = kj::str(s.slice(start, pos));
    return kj::mv(v);
  }
};

// Parse a package.json's top-level value once. Returns kj::none on malformed input.
kj::Maybe<kj::Own<JsonValue>> parsePackageJson(kj::StringPtr text) {
  JsonParser p(text);
  return p.parse();
}

// ======================================================================================
// Node-style conditional `exports` / `imports` resolution (subset of the ESM spec).
//
// We pick conditions to honor based on resolve method + the fact that we always run in a
// node/default (NOT browser) environment. Order of preference within a conditions object follows
// the object's own key order (Node semantics), so we iterate `obj` in insertion order.

// Returns true if a condition name should be honored. `forImport` selects import vs require.
bool conditionMatches(kj::StringPtr cond, bool forImport) {
  if (cond == "default"_kj) return true;
  if (cond == "node"_kj) return true;
  if (cond == "node-addons"_kj) return true;
  // We explicitly do NOT honor "browser" -- we want the node/default build (Vite's deps ship
  // browser builds that pull in browser-only globals).
  if (cond == "import"_kj) return forImport;
  if (cond == "require"_kj) return !forImport;
  // Deliberately do NOT honor "module" / "module-sync". These are bundler-targeted conditions
  // (webpack/esbuild) that frequently point at *.js ESM-bundler output which is NOT directly
  // loadable by a real module loader (it mixes import/export with require()/exports., so our
  // .js CJS-vs-ESM classifier mis-detects it as CJS and compilation fails with "Cannot use import
  // statement outside a module"). Node's own resolver does not treat "module" as a standard import
  // condition. Skipping them makes packages like @emnapi/core resolve via their "import": "*.mjs"
  // entry (unambiguously ESM) -- matching the proven enhanced-resolve config used by the harness
  // (conditionNames: ["node","import","default"]).
  // Vite uses a "development" / "production" split for some deps; prefer development (it has the
  // full, unminified resolver paths and is what `vite` runs under by default).
  if (cond == "development"_kj) return true;
  if (cond == "production"_kj) return false;
  return false;
}

// Forward declaration: recursively resolve an exports/imports *target* (string, array of fallbacks,
// or nested conditions object) into a relative path (begins with "./"). `patternMatch` is the text
// captured by a "*" in the key, substituted into "*" in the target (subpath patterns).
kj::Maybe<kj::String> resolveTarget(
    JsonValue& target, kj::StringPtr patternMatch, bool forImport) {
  switch (target.type) {
    case JsonValue::Type::STRING: {
      // Substitute every "*" in the target with the captured pattern text.
      auto& t = target.str;
      if (!t.startsWith("./") && !t.startsWith("../") && !t.startsWith("/")) {
        // Targets must be relative for our purposes (bare re-exports like "node:fs" are handled by
        // the caller bailing to native resolution). Reject otherwise.
        if (!t.startsWith("#")) return kj::none;
      }
      if (patternMatch.size() == 0 && !t.contains("*"_kj)) {
        return kj::str(t);
      }
      // Replace all '*' with patternMatch.
      kj::Vector<char> out;
      for (char c: t) {
        if (c == '*') {
          for (char pc: patternMatch) out.add(pc);
        } else {
          out.add(c);
        }
      }
      out.add('\0');
      return kj::String(out.releaseAsArray());
    }
    case JsonValue::Type::OBJECT: {
      // Conditions object: first matching condition wins (insertion order).
      for (auto& e: target.obj) {
        kj::StringPtr cond = kj::get<0>(e);
        if (conditionMatches(cond, forImport)) {
          KJ_IF_SOME(r, resolveTarget(*kj::get<1>(e), patternMatch, forImport)) {
            return kj::mv(r);
          }
        }
      }
      return kj::none;
    }
    case JsonValue::Type::ARRAY: {
      // Fallback array: first resolvable entry wins.
      for (auto& el: target.arr) {
        KJ_IF_SOME(r, resolveTarget(*el, patternMatch, forImport)) {
          return kj::mv(r);
        }
      }
      return kj::none;
    }
    default:
      return kj::none;
  }
}

// Given an `exports` (or `imports`) map value and a subpath key (e.g. "." or "./foo" or "#dep"),
// resolve to a relative target path. Implements exact-match first, then longest-matching "*"
// pattern (PACKAGE_IMPORTS_EXPORTS_RESOLVE).
kj::Maybe<kj::String> resolveExportsKey(
    JsonValue& exportsVal, kj::StringPtr subpath, bool forImport) {
  // Case A: exports is a string / array / conditions-without-subpath-keys, and subpath is ".".
  // Node treats `"exports": "./x.js"` or `"exports": { "import": ..., "require": ... }` as the "."
  // entry. We detect "conditions object" vs "subpath object" by whether keys start with "." or "#".
  bool isSubpathMap = false;
  if (exportsVal.type == JsonValue::Type::OBJECT) {
    for (auto& e: exportsVal.obj) {
      kj::StringPtr k = kj::get<0>(e);
      if (k.startsWith("."_kj) || k.startsWith("#"_kj)) {
        isSubpathMap = true;
      }
      break;  // Node: a map is either all-subpath-keys or all-condition-keys; check the first.
    }
  }

  if (!isSubpathMap) {
    // Sugar form: the whole value is the target for ".".
    if (subpath != "."_kj) return kj::none;
    return resolveTarget(exportsVal, ""_kj, forImport);
  }

  // Subpath map. 1) exact match.
  KJ_IF_SOME(exact, exportsVal.get(subpath)) {
    return resolveTarget(exact, ""_kj, forImport);
  }

  // 2) longest "*" pattern match. Keys look like "./foo/*" or "./*" (or "#internal/*").
  kj::Maybe<kj::String> bestMatch;
  kj::Maybe<JsonValue&> bestTarget;
  size_t bestPrefixLen = 0;
  for (auto& e: exportsVal.obj) {
    kj::StringPtr key = kj::get<0>(e);
    KJ_IF_SOME(starPos, key.findFirst('*')) {
      auto prefix = kj::str(key.slice(0, starPos));
      auto suffix = kj::str(key.slice(starPos + 1));
      if (subpath.size() < prefix.size() + suffix.size()) continue;
      if (!subpath.startsWith(prefix)) continue;
      if (suffix.size() > 0 && !subpath.endsWith(suffix)) continue;
      // Capture the text matched by '*'.
      auto captured = subpath.slice(prefix.size(), subpath.size() - suffix.size());
      if (prefix.size() >= bestPrefixLen) {
        bestPrefixLen = prefix.size();
        bestMatch = kj::str(captured);
        bestTarget = *kj::get<1>(e);
      }
    }
  }
  KJ_IF_SOME(target, bestTarget) {
    auto captured = KJ_ASSERT_NONNULL(bestMatch).asPtr();
    return resolveTarget(target, captured, forImport);
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
  bool forImport = method != jsg::ModuleRegistry::ResolveMethod::REQUIRE;
  // package.json exports/main/module
  auto pkgJsonPath = kj::str(dir, "/package.json");
  KJ_IF_SOME(pkgText, vfsReadText(js, tmpDir, pkgJsonPath)) {
    KJ_IF_SOME(parsed, parsePackageJson(pkgText)) {
      // 1) `exports` takes precedence over main/module when present. Resolve the "." subpath.
      KJ_IF_SOME(exportsVal, parsed->get("exports"_kj)) {
        KJ_IF_SOME(rel, resolveExportsKey(exportsVal, "."_kj, forImport)) {
          auto target = joinPath(dir, rel);
          // exports targets are exact (no extension probing per spec) but be lenient: try the file,
          // then with extensions, then index.
          KJ_IF_SOME(file, resolveAsFile(js, tmpDir, target, method)) {
            return kj::mv(file);
          }
          auto indexInTarget = kj::str(target, "/index");
          KJ_IF_SOME(file, resolveAsFile(js, tmpDir, indexInTarget, method)) {
            return kj::mv(file);
          }
        }
        // When `exports` exists but the "." entry doesn't resolve, Node blocks falling back to
        // main. But empirically many packages still want main if exports has only subpaths and no
        // ".". We only block when a "." (or sugar) entry existed. Fall through to main otherwise.
      }
    }

    // 2) Legacy main/module.
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

// Split a bare specifier into a package name and the subpath portion ("." for the root). Handles
// scoped packages (@scope/name) and deep subpaths (name/sub/path).
//   "foo"            -> ("foo", ".")
//   "foo/bar"        -> ("foo", "./bar")
//   "@s/foo"         -> ("@s/foo", ".")
//   "@s/foo/bar"     -> ("@s/foo", "./bar")
struct PackageSpec {
  kj::String name;
  kj::String subpath;  // "." or "./..."
};
PackageSpec splitBareSpecifier(kj::StringPtr spec) {
  size_t slashCount = spec.startsWith("@") ? 2 : 1;
  size_t seen = 0;
  size_t nameEnd = spec.size();
  for (size_t i = 0; i < spec.size(); i++) {
    if (spec[i] == '/') {
      seen++;
      if (seen == slashCount) {
        nameEnd = i;
        break;
      }
    }
  }
  auto name = kj::str(spec.slice(0, nameEnd));
  kj::String subpath;
  if (nameEnd >= spec.size()) {
    subpath = kj::str(".");
  } else {
    subpath = kj::str(".", spec.slice(nameEnd));  // -> "./rest"
  }
  return PackageSpec{.name = kj::mv(name), .subpath = kj::mv(subpath)};
}

// Resolve a bare specifier against a single package directory (`pkgDir`), honoring an `exports`
// map when present (which then BLOCKS any subpath not listed, like Node). Returns kj::none if this
// package dir doesn't satisfy the specifier so the caller keeps walking up node_modules.
kj::Maybe<kj::String> resolveInPackage(jsg::Lock& js,
    Directory& tmpDir,
    kj::StringPtr pkgDir,
    kj::StringPtr subpath,
    jsg::ModuleRegistry::ResolveMethod method) {
  bool forImport = method != jsg::ModuleRegistry::ResolveMethod::REQUIRE;
  auto pkgJsonPath = kj::str(pkgDir, "/package.json");
  KJ_IF_SOME(pkgText, vfsReadText(js, tmpDir, pkgJsonPath)) {
    KJ_IF_SOME(parsed, parsePackageJson(pkgText)) {
      KJ_IF_SOME(exportsVal, parsed->get("exports"_kj)) {
        // exports present: it is authoritative. A subpath not covered by exports is blocked.
        KJ_IF_SOME(rel, resolveExportsKey(exportsVal, subpath, forImport)) {
          auto target = joinPath(pkgDir, rel);
          KJ_IF_SOME(file, resolveAsFile(js, tmpDir, target, method)) {
            return kj::mv(file);
          }
          // exports may point at a directory index (rare but legal via "./foo/").
          auto indexInTarget = kj::str(target, "/index");
          KJ_IF_SOME(file, resolveAsFile(js, tmpDir, indexInTarget, method)) {
            return kj::mv(file);
          }
          // exports matched but file missing -> hard fail for this package (Node behavior).
          return kj::none;
        }
        // exports present but subpath not exported. For "." fall through to main/module/index
        // (handled by resolveAsDirectory). For deep subpaths, Node blocks; we mirror that by
        // returning none so the deep path isn't reachable through the legacy file walk.
        if (subpath != "."_kj) {
          return kj::none;
        }
      }
    }
  }

  // No exports (or "." not exported): legacy resolution.
  if (subpath == "."_kj) {
    KJ_IF_SOME(file, resolveAsFile(js, tmpDir, pkgDir, method)) {
      return kj::mv(file);
    }
    if (vfsIsDir(js, tmpDir, pkgDir)) {
      return resolveAsDirectory(js, tmpDir, pkgDir, method);
    }
    return kj::none;
  }

  // Deep subpath without exports: resolve relative to the package dir.
  auto target = joinPath(pkgDir, subpath);
  KJ_IF_SOME(file, resolveAsFile(js, tmpDir, target, method)) {
    return kj::mv(file);
  }
  if (vfsIsDir(js, tmpDir, target)) {
    return resolveAsDirectory(js, tmpDir, target, method);
  }
  return kj::none;
}

// Walk node_modules up the directory tree starting at `fromDir`, looking for the bare specifier.
kj::Maybe<kj::String> resolveBare(jsg::Lock& js,
    Directory& tmpDir,
    kj::StringPtr fromDir,
    kj::StringPtr spec,
    jsg::ModuleRegistry::ResolveMethod method) {
  auto split = splitBareSpecifier(spec);
  auto dir = kj::str(fromDir);
  while (true) {
    // Skip a node_modules dir nested inside another node_modules path component duplication is
    // fine; node walks every ancestor including ones already under node_modules.
    auto pkgDir = kj::str(dir, "/node_modules/", split.name);
    if (vfsIsDir(js, tmpDir, pkgDir) ||
        vfsIsFile(js, tmpDir, kj::str(dir, "/node_modules/", split.name))) {
      KJ_IF_SOME(file, resolveInPackage(js, tmpDir, pkgDir, split.subpath, method)) {
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

// Resolve a `#`-prefixed `imports` specifier relative to the nearest package.json walking up from
// `fromDir`. Returns the absolute VFS path of the resolved module, or kj::none.
kj::Maybe<kj::String> resolveImports(jsg::Lock& js,
    Directory& tmpDir,
    kj::StringPtr fromDir,
    kj::StringPtr spec,
    jsg::ModuleRegistry::ResolveMethod method) {
  bool forImport = method != jsg::ModuleRegistry::ResolveMethod::REQUIRE;
  auto dir = kj::str(fromDir);
  while (true) {
    auto pkgJsonPath = kj::str(dir, "/package.json");
    KJ_IF_SOME(pkgText, vfsReadText(js, tmpDir, pkgJsonPath)) {
      KJ_IF_SOME(parsed, parsePackageJson(pkgText)) {
        KJ_IF_SOME(importsVal, parsed->get("imports"_kj)) {
          KJ_IF_SOME(rel, resolveExportsKey(importsVal, spec, forImport)) {
            // An imports target may be a relative path (resolved against the package dir) OR a bare
            // specifier (resolved through node_modules from the package dir).
            if (rel.startsWith("./") || rel.startsWith("../") || rel.startsWith("/")) {
              auto target = joinPath(dir, rel);
              KJ_IF_SOME(file, resolveAsFile(js, tmpDir, target, method)) {
                return kj::mv(file);
              }
              if (vfsIsDir(js, tmpDir, target)) {
                return resolveAsDirectory(js, tmpDir, target, method);
              }
              return kj::none;
            }
            // Bare re-export (e.g. "#dep": "some-pkg").
            return resolveBare(js, tmpDir, dir, rel, method);
          }
        }
      }
      // Found the nearest package.json; whether or not imports matched, stop here (Node resolves
      // imports against the nearest package scope only).
      return kj::none;
    }
    if (dir == kVfsRoot || dir == "/"_kj || dir.size() <= kVfsRoot.size()) break;
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

  // `#`-prefixed private imports map. Resolved against the nearest package.json above the importer.
  if (rawSpec.startsWith("#")) {
    return resolveImports(js, tmpDir, baseDir, rawSpec, method);
  }

  // Bare specifier (incl. scoped packages and subpaths). Walk node_modules.
  return resolveBare(js, tmpDir, baseDir, rawSpec, method);
}

// ======================================================================================
// Source classification + named-export discovery.

// Walk up from the module file looking for the nearest package.json `type` field. The first
// package.json found wins (Node's nearest-scope rule) regardless of whether it declares `type`.
bool packageTypeIsModule(jsg::Lock& js, Directory& tmpDir, kj::StringPtr filePath) {
  auto dir = dirnameOf(filePath);
  while (true) {
    auto pkgJsonPath = kj::str(dir, "/package.json");
    KJ_IF_SOME(text, vfsReadText(js, tmpDir, pkgJsonPath)) {
      KJ_IF_SOME(parsed, parsePackageJson(text)) {
        KJ_IF_SOME(typeVal, parsed->get("type"_kj)) {
          if (typeVal.type == JsonValue::Type::STRING) {
            return typeVal.str == "module"_kj;
          }
        }
      }
      // Nearest package.json found but no (parseable) `type` -> defaults to CommonJS scope.
      return false;
    }
    if (dir == kVfsRoot || dir == "/"_kj || dir.size() <= kVfsRoot.size()) break;
    auto parent = dirnameOf(dir);
    if (parent == dir) break;
    dir = kj::mv(parent);
  }
  return false;
}

enum class ModFormat { ESM, CJS, JSON };

// True if `src` contains a statement-position ESM keyword: a `export`/`import` token that
// begins a logical line (preceded only by start-of-file or a newline + optional whitespace)
// and is followed by a delimiter that makes it the `export`/`import` *statement* form
// (space, `{`, `*`, or `(default`). Statement-position `export`/`import` cannot appear in
// CommonJS, so this is a definitive ESM signal — far stronger than a bare substring search,
// which trips on `exports.foo` (CJS), `@import url(…)` in comments, or the word "export" in
// strings. Conservative: only matches the unambiguous statement forms.
bool hasToplevelEsmStatement(kj::StringPtr src) {
  auto data = src.asArray();
  size_t n = data.size();
  auto atLineStartKeyword = [&](size_t i, kj::StringPtr kw) -> bool {
    // `i` must be at start-of-file or right after a newline + optional spaces/tabs.
    size_t j = i;
    while (j > 0) {
      char c = data[j - 1];
      if (c == ' ' || c == '\t') { j--; continue; }
      if (c == '\n' || c == '\r') break;
      return false;  // non-whitespace before keyword on this line
    }
    // keyword match
    if (i + kw.size() > n) return false;
    for (size_t k = 0; k < kw.size(); k++) {
      if (data[i + k] != kw[k]) return false;
    }
    // char following the keyword: must be a delimiter for the statement form
    char after = (i + kw.size() < n) ? data[i + kw.size()] : '\0';
    return after == ' ' || after == '\t' || after == '{' || after == '*' ||
        after == '\n' || after == '\r';
  };
  for (size_t i = 0; i < n; i++) {
    char c = data[i];
    if (c == 'e' && atLineStartKeyword(i, "export"_kj)) return true;
    if (c == 'i' && atLineStartKeyword(i, "import"_kj)) return true;
  }
  return false;
}

ModFormat classify(jsg::Lock& js, Directory& tmpDir, kj::StringPtr filePath, kj::StringPtr src) {
  auto ext = extnameOf(filePath);
  if (ext == ".json"_kj) return ModFormat::JSON;
  if (ext == ".mjs"_kj) return ModFormat::ESM;
  if (ext == ".cjs"_kj) return ModFormat::CJS;
  if (packageTypeIsModule(js, tmpDir, filePath)) return ModFormat::ESM;
  // Definitive ESM: a statement-position `export`/`import`. This wins even when the file
  // also contains `exports.`/`require(` — e.g. a bundled `esm/` build (esbuild-wasm's
  // esm/browser.js has real top-level `export` statements alongside `exports.` inside its
  // `__export(exports, …)` helpers). A bare substring search misclassified it as CJS and
  // the top-level `export` then threw "Unexpected token 'export'".
  if (hasToplevelEsmStatement(src)) return ModFormat::ESM;
  // Otherwise fall back to the substring heuristic. CommonJS signals: besides the obvious
  // `module.exports` / `exports.foo` / `require(`, Babel/TypeScript-transpiled CJS marks
  // itself with `Object.defineProperty(exports, "__esModule", …)` and assigns named exports
  // via `Object.defineProperty(exports, "name", …)` — touching the `exports` free variable
  // WITHOUT ever writing `exports.foo` or `module.exports` (e.g.
  // tailwindcss/lib/lib/collapseAdjacentRules.js). Those have no `require(` either, so the
  // old heuristic missed them; worse, `import ` can appear inside a comment (`@import url(…)`),
  // which flipped looksEsm true and mis-loaded the module as ESM ("exports is not defined").
  bool looksEsm = src.contains("export "_kj) || src.contains("export{"_kj) ||
      src.contains("export*"_kj) || src.contains("import "_kj) || src.contains("import{"_kj);
  bool looksCjs = src.contains("module.exports"_kj) || src.contains("exports."_kj) ||
      src.contains("require("_kj) || src.contains("__esModule"_kj) ||
      src.contains("Object.defineProperty(exports"_kj) ||
      src.contains("Object.defineProperty(module.exports"_kj);
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
