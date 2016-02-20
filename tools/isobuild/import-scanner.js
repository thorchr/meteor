import assert from "assert";
import {isString, has, keys, each, map, without} from "underscore";
import {sha1, readAndWatchFileWithHash} from "../fs/watch.js";
import {matches as archMatches} from "../utils/archinfo.js";
import {findImportedModuleIdentifiers} from "./js-analyze.js";
import buildmessage from "../utils/buildmessage.js";
import LRU from "lru-cache";
import {Profile} from "../tool-env/profile.js";
import {
  pathJoin,
  pathRelative,
  pathNormalize,
  pathDirname,
  pathBasename,
  pathExtname,
  statOrNull,
  convertToPosixPath,
} from "../fs/files.js";

const nativeModulesMap = Object.create(null);

Object.keys(process.binding("natives")).forEach(id => {
  if (id === "freelist" ||
      id.startsWith("internal/")) {
    return;
  }

  nativeModulesMap[id] = true;
});

// Default handlers for well-known file extensions.
// Note that these function expect strings, not Buffer objects.
const defaultExtensionHandlers = {
  ".js"(dataString) {
    // Strip any #! line from the beginning of the file.
    return dataString.replace(/^#![^\n]*/, "");
  },

  ".json"(dataString) {
    return "module.exports = " +
      JSON.stringify(JSON.parse(dataString), null, 2) +
      ";\n";
  }
};

// Map from SHA (which is already calculated, so free for us)
// to the results of calling findImportedModuleIdentifiers.
// Each entry is an array of strings, and this is a case where
// the computation is expensive but the output is very small.
// The cache can be global because findImportedModuleIdentifiers
// is a pure function, and that way it applies across instances
// of ImportScanner (which do not persist across builds).
const IMPORT_SCANNER_CACHE = new LRU({
  max: 1024*1024,
  length(value) {
    let total = 40; // size of key
    value.forEach(str => { total += str.length; });
    return total;
  }
});

export default class ImportScanner {
  constructor({
    name,
    bundleArch,
    extensions = [".js", ".json"],
    sourceRoot,
    usedPackageNames = {},
    nodeModulesPath,
    watchSet,
  }) {
    assert.ok(isString(sourceRoot));

    this.name = name;
    this.bundleArch = bundleArch;
    this.extensions = extensions;
    this.sourceRoot = sourceRoot;
    this.usedPackageNames = usedPackageNames;
    this.nodeModulesPath = nodeModulesPath;
    this.watchSet = watchSet;
    this.absPathToOutputIndex = Object.create(null);
    this.allMissingNodeModules = Object.create(null);
    this.outputFiles = [];

    this._statCache = new Map;
    this._pkgJsonCache = new Map;
  }

  addInputFiles(files) {
    files.forEach(file => {
      const absPath = pathJoin(this.sourceRoot, file.sourcePath);

      const dotExt = "." + file.type;
      const dataString = file.data.toString("utf8");
      file.dataString = defaultExtensionHandlers[dotExt](dataString);
      if (file.dataString !== dataString) {
        file.data = new Buffer(file.dataString, "utf8");
      }

      // Files that are not eagerly evaluated (lazy) will only be included
      // in the bundle if they are actually imported. Files that are
      // eagerly evaluated are effectively "imported" as entry points.
      file.imported = ! file.lazy;

      file.installPath = this._getInstallPath(absPath);

      if (has(this.absPathToOutputIndex, absPath)) {
        const index = this.absPathToOutputIndex[absPath];
        this.outputFiles[index] = file;
      } else {
        this.absPathToOutputIndex[absPath] =
          this.outputFiles.push(file) - 1;
      }
    });

    return this;
  }

  scanImports() {
    this.outputFiles.forEach(file => {
      if (! file.lazy || file.imported) {
        this._scanFile(file);
      }
    });

    return this;
  }

  addNodeModules(identifiers) {
    const newMissingNodeModules = Object.create(null);

    if (identifiers) {
      if (typeof identifiers === "object" &&
          ! Array.isArray(identifiers)) {
        identifiers = Object.keys(identifiers);
      }

      if (identifiers.length > 0) {
        const previousAllMissingNodeModules = this.allMissingNodeModules;
        this.allMissingNodeModules = newMissingNodeModules;

        try {
          this._scanFile({
            sourcePath: "fake.js",
            // By specifying the .deps property of this fake file ahead of
            // time, we can avoid calling findImportedModuleIdentifiers in the
            // _scanFile method.
            deps: identifiers,
          });

        } finally {
          this.allMissingNodeModules = previousAllMissingNodeModules;

          // Remove previously seen missing module identifiers from
          // newMissingNodeModules and merge the new identifiers back into
          // this.allMissingNodeModules.
          each(keys(newMissingNodeModules), key => {
            if (has(previousAllMissingNodeModules, key)) {
              delete newMissingNodeModules[key];
            } else {
              previousAllMissingNodeModules[key] =
                newMissingNodeModules[key];
            }
          });
        }
      }
    }

    return newMissingNodeModules;
  }

  getOutputFiles(options) {
    // Return all installable output files that are either eager or
    // imported by another module.
    return this.outputFiles.filter(file => {
      return file.installPath && (! file.lazy || file.imported);
    });
  }

  _findImportedModuleIdentifiers(file) {
    if (IMPORT_SCANNER_CACHE.has(file.hash)) {
      return IMPORT_SCANNER_CACHE.get(file.hash);
    }

    const result = keys(findImportedModuleIdentifiers(
      file.dataString,
      file.hash,
    ));

    // there should always be file.hash, but better safe than sorry
    if (file.hash) {
      IMPORT_SCANNER_CACHE.set(file.hash, result);
    }

    return result;
  }

  _scanFile(file) {
    const absPath = pathJoin(this.sourceRoot, file.sourcePath);

    try {
      file.deps = file.deps || this._findImportedModuleIdentifiers(file);
    } catch (e) {
      if (e.$ParseError) {
        buildmessage.error(e.message, {
          file: file.sourcePath,
          line: e.loc.line,
          column: e.loc.column,
        });
        return;
      }
      throw e;
    }

    each(file.deps, id => {
      const resolved = this._tryToResolveImportedPath(file, id);
      if (! resolved) {
        return;
      }

      const absImportedPath = resolved.path;

      if (has(this.absPathToOutputIndex, absImportedPath)) {
        // Avoid scanning files that we've scanned before, but mark them
        // as imported so we know to include them in the bundle if they
        // are lazy.
        const index = this.absPathToOutputIndex[absImportedPath];
        const file = this.outputFiles[index];

        // Eager files and files that we have imported before do not need
        // to be scanned again. Lazy files that we have not imported
        // before still need to be scanned, however.
        const alreadyScanned = ! file.lazy || file.imported;

        // Whether the file is eager or lazy, mark it as imported. For
        // lazy files, this makes the difference between being included in
        // or omitted from the bundle. For eager files, this just ensures
        // we won't scan them again.
        file.imported = true;

        if (! alreadyScanned) {
          this._scanFile(file);
        }

        return;
      }

      if (! this._hasDefaultExtension(absImportedPath)) {
        // The _readModule method provides hardcoded support for files
        // with known extensions, but any other type of file must be
        // ignored at this point, because it was not in the set of input
        // files and therefore must not have been processed by a compiler
        // plugin for the current architecture (this.bundleArch).
        return;
      }

      const installPath = this._getInstallPath(absImportedPath);
      if (! installPath) {
        // The given path cannot be installed on this architecture.
        return;
      }

      // The object returned by _readModule will have .data, .dataString,
      // and .hash properties.
      const depFile = this._readModule(absImportedPath);
      depFile.type = "js"; // TODO Is this correct?
      depFile.sourcePath = pathRelative(this.sourceRoot, absImportedPath);
      depFile.installPath = installPath;
      depFile.servePath = installPath;
      depFile.lazy = true;
      depFile.imported = true;

      // Append this file to the output array and record its index.
      this.absPathToOutputIndex[absImportedPath] =
        this.outputFiles.push(depFile) - 1;

      this._scanFile(depFile);
    });
  }

  _readFile(absPath) {
    let { contents, hash } =
      readAndWatchFileWithHash(this.watchSet, absPath);

    return {
      data: contents,
      dataString: contents.toString("utf8"),
      hash
    };
  }

  _readModule(absPath) {
    const info = this._readFile(absPath);
    const dataString = info.dataString;

    // Same logic/comment as stripBOM in node/lib/module.js:
    // Remove byte order marker. This catches EF BB BF (the UTF-8 BOM)
    // because the buffer-to-string conversion in `fs.readFileSync()`
    // translates it to FEFF, the UTF-16 BOM.
    if (info.dataString.charCodeAt(0) === 0xfeff) {
      info.dataString = info.data.slice(1);
    }

    const ext = pathExtname(absPath).toLowerCase();
    info.dataString = defaultExtensionHandlers[ext](info.dataString);

    if (info.dataString !== dataString) {
      info.data = new Buffer(info.dataString, "utf8");
    }

    return info;
  }

  // Returns a relative path indicating where to install the given file
  // via meteorInstall. May return undefined if the file should not be
  // installed on the current architecture.
  _getInstallPath(absPath) {
    let path =
      this._getNodeModulesInstallPath(absPath) ||
      this._getSourceRootInstallPath(absPath);

    if (! path) {
      return;
    }

    if (this.name) {
      // If we're bundling a package, prefix path with
      // node_modules/<package name>/.
      path = pathJoin("node_modules", "meteor", this.name, path);
    }

    return path;
  }

  _getNodeModulesInstallPath(absPath) {
    if (this.nodeModulesPath) {
      const relPathWithinNodeModules =
        pathRelative(this.nodeModulesPath, absPath);

      if (relPathWithinNodeModules.startsWith("..")) {
        // absPath is not a subdirectory of this.nodeModulesPath.
        return;
      }

      if (! this._hasDefaultExtension(relPathWithinNodeModules)) {
        // Only accept files within node_modules directories if they
        // have one of the known extensions.
        return;
      }

      // Install the module into the local node_modules directory within
      // this app or package.
      return pathJoin("node_modules", relPathWithinNodeModules);
    }
  }

  _getSourceRootInstallPath(absPath) {
    const installPath = pathRelative(this.sourceRoot, absPath);

    if (installPath.startsWith("..")) {
      // absPath is not a subdirectory of this.sourceRoot.
      return;
    }

    const dirs = this._splitPath(pathDirname(installPath));
    const isApp = ! this.name;
    const bundlingForWeb = archMatches(this.bundleArch, "web");

    const topLevelDir = dirs[0];
    if (topLevelDir === "private" ||
        topLevelDir === "packages" ||
        topLevelDir === "programs" ||
        topLevelDir === "cordova-build-override") {
      // Don't load anything from these special top-level directories
      return;
    }

    for (let dir of dirs) {
      if (dir.charAt(0) === ".") {
        // Files/directories whose names start with a dot are never loaded
        return;
      }

      if (isApp) {
        if (bundlingForWeb) {
          if (dir === "server") {
            // If we're bundling an app for a client architecture, any files
            // contained by a server-only directory that is not contained by
            // a node_modules directory must be ignored.
            return;
          }
        } else if (dir === "client") {
          // If we're bundling an app for a server architecture, any files
          // contained by a client-only directory that is not contained by
          // a node_modules directory must be ignored.
          return;
        }
      }

      if (dir === "node_modules") {
        if (! this._hasDefaultExtension(installPath)) {
          // Reject any files within node_modules directories that do
          // not have one of the known extensions.
          return;
        }

        // Accept any file within a node_modules directory if it has a
        // known file extension.
        return installPath;
      }
    }

    return installPath;
  }

  _hasDefaultExtension(path) {
    return has(
      defaultExtensionHandlers,
      pathExtname(path).toLowerCase()
    );
  }

  _splitPath(path) {
    const partsInReverse = [];
    for (let dir; (dir = pathDirname(path)) !== path; path = dir) {
      partsInReverse.push(pathBasename(path));
    }
    return partsInReverse.reverse();
  }

  // TODO This method can probably be consolidated with _getInstallPath.
  _tryToResolveImportedPath(file, id, seenDirPaths) {
    let resolved =
      this._resolveAbsolute(file, id) ||
      this._resolveRelative(file, id) ||
      this._resolveNodeModule(file, id);

    while (resolved && resolved.stat.isDirectory()) {
      let dirPath = resolved.path;
      seenDirPaths = seenDirPaths || new Set;

      // If the "main" field of a package.json file resolves to a
      // directory we've already considered, then we should not attempt to
      // read the same package.json file again.
      if (! seenDirPaths.has(dirPath)) {
        seenDirPaths.add(dirPath);
        resolved = this._resolvePkgJsonMain(dirPath, seenDirPaths);
        if (resolved) {
          // The _resolvePkgJsonMain call above may have returned a
          // directory, so continue the loop to make sure we fully resolve
          // it to a non-directory.
          continue;
        }
      }

      // If we didn't find a `package.json` file, or it didn't have a
      // resolvable `.main` property, the only possibility left to
      // consider is that this directory contains an `index.js` module.
      // This assignment almost always terminates the while loop, because
      // there's very little chance an `index.js` file will be a
      // directory. However, in principle it is remotely possible that a
      // file called `index.js` could be a directory instead of a file.
      resolved = this._joinAndStat(dirPath, "index.js");
    }

    return resolved;
  }

  _joinAndStat(...joinArgs) {
    const joined = pathJoin(...joinArgs);
    if (this._statCache.has(joined)) {
      return this._statCache.get(joined);
    }

    const path = pathNormalize(joined);
    const exactStat = statOrNull(path);
    const exactResult = exactStat && { path, stat: exactStat };
    let result = null;
    if (exactResult && exactStat.isFile()) {
      result = exactResult;
    }

    if (! result) {
      this.extensions.some(ext => {
        const pathWithExt = path + ext;
        const stat = statOrNull(pathWithExt);
        if (stat) {
          return result = { path: pathWithExt, stat };
        }
      });
    }

    if (! result && exactResult && exactStat.isDirectory()) {
      // After trying all available file extensions, fall back to the
      // original result if it was a directory.
      result = exactResult;
    }

    this._statCache.set(joined, result);
    return result;
  }

  _resolveAbsolute(file, id) {
    return id.charAt(0) === "/" &&
      this._joinAndStat(this.sourceRoot, id.slice(1));
  }

  _resolveRelative({ sourcePath }, id) {
    if (id.charAt(0) === ".") {
      return this._joinAndStat(
        this.sourceRoot, sourcePath, "..", id
      );
    }
  }

  _resolveNodeModule(file, id) {
    const isNative = has(nativeModulesMap, id);
    if (isNative && archMatches(this.bundleArch, "os")) {
      // Forbid installing any server module with the same name as a
      // native Node module.
      return null;
    }

    let dir = pathJoin(this.sourceRoot, file.sourcePath);
    let resolved = this._joinAndStat(dir);
    if (! resolved || ! resolved.stat.isDirectory()) {
      dir = pathDirname(dir);
    }

    while (! (resolved = this._joinAndStat(dir, "node_modules", id)) &&
           dir !== this.sourceRoot) {
      dir = pathDirname(dir);
    }

    if (! resolved && this.nodeModulesPath) {
      // After checking any local node_modules directories, fall back to
      // the package NPM directory, if one was specified.
      resolved = this._joinAndStat(this.nodeModulesPath, id);
    }

    if (! resolved) {
      // If the imported identifier is neither absolute nor relative, but
      // top-level, then it might be satisfied by a package installed in
      // the top-level node_modules directory, and we should record the
      // missing dependency so that we can include it in the app bundle.
      const missing = file.missingNodeModules || Object.create(null);
      this.allMissingNodeModules[id] = missing[id] = true;
      file.missingNodeModules = missing;
    }

    // If the dependency is still not resolved, it might be handled by the
    // fallback function defined in meteor/packages/modules/modules.js, or
    // it might be imported in code that will never run on this platform,
    // so there is always the possibility that its absence is not actually
    // a problem. As much as we might like to issue warnings about missing
    // dependencies here, we just don't have enough information to make
    // that determination until the code actually runs.

    return resolved;
  }

  _readPkgJson(path) {
    if (this._pkgJsonCache.has(path)) {
      return this._pkgJsonCache.get(path);
    }

    let result = null;
    try {
      result = JSON.parse(this._readFile(path).dataString);
    } catch (e) {
      // leave result null
    }

    this._pkgJsonCache.set(path, result);
    return result;
  }

  _resolvePkgJsonMain(dirPath, seenDirPaths) {
    const pkgJsonPath = pathJoin(dirPath, "package.json");
    const pkg = this._readPkgJson(pkgJsonPath);
    if (! pkg) {
      return null;
    }

    let main = pkg.main;

    if (archMatches(this.bundleArch, "web") &&
        isString(pkg.browser)) {
      main = pkg.browser;
    }

    if (isString(main)) {
      // The "main" field of package.json does not have to begin with ./
      // to be considered relative, so first we try simply appending it to
      // the directory path before falling back to a full resolve, which
      // might return a package from a node_modules directory.
      const resolved = this._joinAndStat(dirPath, main) ||
        // The _tryToResolveImportedPath method takes a file object as its
        // first parameter, but only the .sourcePath property is ever
        // used, so we can get away with passing a fake directory file
        // object with only that property.
        this._tryToResolveImportedPath({
          sourcePath: pathRelative(this.sourceRoot, dirPath),
        }, main, seenDirPaths);

      if (resolved) {
        // Output a JS module that exports just the "name", "version", and
        // "main" properties defined in the package.json file.
        const pkgSubset = {
          name: pkg.name,
        };

        if (has(pkg, "version")) {
          pkgSubset.version = pkg.version;
        }

        pkgSubset.main = main;

        this._addPkgJsonToOutput(pkgJsonPath, pkgSubset);

        return resolved;
      }
    }

    return null;
  }

  _addPkgJsonToOutput(pkgJsonPath, pkg) {
    if (! has(this.absPathToOutputIndex, pkgJsonPath)) {
      const data = new Buffer(map(pkg, (value, key) => {
        return `exports.${key} = ${JSON.stringify(value)};\n`;
      }).join(""));

      const relPkgJsonPath = pathRelative(this.sourceRoot, pkgJsonPath);

      const pkgFile = {
        type: "js", // We represent the JSON module with JS.
        data,
        deps: [], // Avoid accidentally re-scanning this file.
        sourcePath: relPkgJsonPath,
        installPath: this._getInstallPath(pkgJsonPath),
        servePath: relPkgJsonPath,
        hash: sha1(data),
        lazy: true,
        imported: true,
      };

      this.absPathToOutputIndex[pkgJsonPath] =
        this.outputFiles.push(pkgFile) - 1;
    }
  }
}

each(["_readFile", "_findImportedModuleIdentifiers",
      "_getInstallPath", "_tryToResolveImportedPath",
      "_resolvePkgJsonMain"], funcName => {
  ImportScanner.prototype[funcName] = Profile(
    `ImportScanner#${funcName}`, ImportScanner.prototype[funcName]);
});
