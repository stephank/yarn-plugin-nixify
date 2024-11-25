import { tmpdir } from "os";

import { Filename, npath, PortablePath, ppath, xfs } from "@yarnpkg/fslib";
import { patchUtils } from "@yarnpkg/plugin-patch";
import { json, indent, renderTmpl, upperCamelize } from "./textUtils";
import {
  Cache,
  YarnVersion,
  execUtils,
  hashUtils,
  InstallMode,
  LocatorHash,
  Package,
  Project,
  Report,
  structUtils,
} from "@yarnpkg/core";

import defaultExprTmpl from "./tmpl/default.nix.in";
import projectExprTmpl from "./tmpl/yarn-project.nix.in";
import {
  computeFixedOutputStorePath,
  hexToSri,
  sanitizeDerivationName,
  sriToHex,
} from "./nixUtils";
import { writeNarStream, writeNarStrings } from "./narUtils";
import { createHash } from "crypto";

const isYarn3 = YarnVersion?.startsWith("3.") || false;

// Generator function that runs after `yarn install`.
export default async (
  project: Project,
  opts: { cache: Cache; report: Report; mode?: InstallMode },
) => {
  const { configuration, cwd } = project;
  const { cache, report } = opts;

  // This case happens with `yarn dlx`, for example, and may cause errors if
  // special settings don't apply to those installations. (Like a `nixExprPath`
  // with a subdir that doesn't exist in the temporary project.)
  //
  // On macOS at least, we also need to get the real path of the OS temp dir,
  // because it goes through a symlink.
  const tempDir = await xfs.realpathPromise(npath.toPortablePath(tmpdir()));
  if (project.cwd.startsWith(tempDir)) {
    report.reportInfo(
      0,
      `Skipping Nixify, because ${project.cwd} appears to be a temporary directory`,
    );
    return;
  }

  // Determine relative paths for Nix path literals.
  const nixExprPath = configuration.get(`nixExprPath`);

  const yarnPathAbs = configuration.get(`yarnPath`);
  let yarnBinExpr: string;
  if (yarnPathAbs === null) {
    // Assume the current running script is the correct Yarn.
    let text = (await xfs.readFilePromise(process.argv[1] as PortablePath)).toString();
    // If yarn was installed via Nix, revert shebang patching to get correct checksum
    if (text.startsWith("#!/nix/store/")) {
      const code = text.substring(text.indexOf("\n") + 1);
      text = `#!/usr/bin/env node\n${code}`;
    }
    const sha512 = hashUtils.makeHash(Buffer.from(text));
    yarnBinExpr = [
      "fetchurl {",
      `  url = "https://repo.yarnpkg.com/${YarnVersion!}/packages/yarnpkg-cli/bin/yarn.js";`,
      `  hash = "${hexToSri(sha512)}";`,
      "}",
    ].join("\n  ");
  } else if (yarnPathAbs.startsWith(cwd)) {
    yarnBinExpr =
      "./" + ppath.relative(ppath.dirname(nixExprPath), yarnPathAbs);
  } else {
    yarnBinExpr = json(yarnPathAbs);
    report.reportWarning(
      0,
      `The Yarn path ${yarnPathAbs} is outside the project - it may not be reachable by the Nix build`,
    );
  }

  const cacheFolderAbs = configuration.get(`cacheFolder`);
  let cacheFolderExpr: string;
  if (cacheFolderAbs.startsWith(cwd)) {
    cacheFolderExpr = json(ppath.relative(cwd, cacheFolderAbs));
  } else if (!isYarn3 && configuration.get(`enableGlobalCache`)) {
    cacheFolderExpr = '".yarn/cache"';
  } else {
    throw Error(
      `The cache folder ${cacheFolderAbs} is outside the project, this is currently not supported`,
    );
  }

  const configSources = new Set();
  for (const sourceList of configuration.sources.values()) {
    for (const source of sourceList.split(", ")) {
      if (!source.startsWith(`<`)) {
        configSources.add(source);
      }
    }
  }
  for (const source of configSources) {
    const relativeSource = ppath.resolve(cwd, source as PortablePath);
    if (!relativeSource.startsWith(cwd)) {
      report.reportWarning(
        0,
        `The config file ${source} is outside the project - it may not be reachable by the Nix build`,
      );
    }
  }

  const lockfileExpr =
    "./" +
    ppath.relative(
      ppath.dirname(nixExprPath),
      ppath.resolve(cwd, "yarn.lock" as PortablePath),
    );

  // Collect all the cache files used.
  interface CacheFile {
    pkg: Package;
    checksum: string | undefined;
    cachePath: PortablePath;
  }
  const cacheFiles = new Map<Filename, CacheFile>();
  const allCacheFiles = new Set(await xfs.readdirPromise(cache.cwd));
  const cacheOptions = { unstablePackages: project.conditionalLocators };
  for (const pkg of project.storedPackages.values()) {
    const { locatorHash } = pkg;
    const checksum = project.storedChecksums.get(locatorHash);
    const cachePath = isYarn3
      ? (cache as any).getLocatorPath(pkg, checksum || null, cacheOptions)
      : cache.getLocatorPath(pkg, checksum || null);
    if (!cachePath) continue;

    if (!allCacheFiles.has(ppath.basename(cachePath))) continue;

    // Rebuild the filename, because the cache file we're operating on may be
    // from the mirror directory, which uses different naming.
    const filename = checksum
      ? cache.getChecksumFilename(pkg, checksum)
      : cache.getVersionFilename(pkg);

    cacheFiles.set(filename, { pkg, checksum, cachePath });
  }

  interface CacheEntry {
    cachePath: PortablePath;
    filename: Filename;
    hash: string;
  }
  const cacheEntries = new Map<string, CacheEntry>();
  const individualDrvs = configuration.get(`individualNixPackaging`);
  let cacheEntriesCode = "";
  let combinedHash = "";
  if (individualDrvs) {
    // Build a list of cache entries so Nix can fetch them.
    // TODO: See if we can use Nix fetchurl for npm: dependencies.
    for (const [
      filename,
      { pkg, checksum, cachePath },
    ] of cacheFiles.entries()) {
      const locatorStr = structUtils.stringifyLocator(pkg);
      const sha512 = checksum
        ? checksum.split(`/`).pop()!
        : await hashUtils.checksumFile(cachePath);
      cacheEntries.set(locatorStr, {
        cachePath,
        filename,
        hash: hexToSri(sha512),
      });
    }

    cacheEntriesCode = `cacheEntries = {\n`;
    for (const locatorStr of [...cacheEntries.keys()].sort()) {
      const entry = cacheEntries.get(locatorStr)!;
      cacheEntriesCode += `${json(locatorStr)} = { ${[
        `filename = ${json(entry.filename)};`,
        `hash = "${entry.hash}";`,
      ].join(` `)} };\n`;
    }
    cacheEntriesCode += `};`;
  } else {
    // Hash a NAR of just the cache files we use.
    const hasher = createHash("sha512");
    writeNarStrings(hasher, "nix-archive-1", "(", "type", "directory");
    for (const filename of [...cacheFiles.keys()].sort()) {
      const { cachePath } = cacheFiles.get(filename)!;
      const { size } = await xfs.statPromise(cachePath);
      writeNarStrings(
        hasher,
        "entry",
        "(",
        "name",
        filename,
        "node",
        "(",
        "type",
        "regular",
        "contents",
      );
      await writeNarStream(hasher, size, xfs.createReadStream(cachePath));
      writeNarStrings(hasher, ")", ")");
    }
    writeNarStrings(hasher, ")");
    hasher.end();
    // Bit hacky, but hashers always produce a single read.
    for await (const sha512 of hasher) {
      combinedHash = hexToSri(sha512);
    }
  }

  // Generate Nix code for isolated builds.
  const isolatedBuilds = configuration.get(`isolatedNixBuilds`);
  let isolatedPackages = new Set<Package>();
  let isolatedIntegration = [];
  let isolatedCode = [];

  const nodeLinker = configuration.get(`nodeLinker`);
  const pnpUnpluggedFolder = configuration.get(`pnpUnpluggedFolder`);

  const collectTree = (pkg: Package, out: Set<string> = new Set()) => {
    const locatorStr = structUtils.stringifyLocator(pkg);
    if (cacheEntries.has(locatorStr)) {
      out.add(locatorStr);
    }

    if (structUtils.isVirtualLocator(pkg)) {
      const devirtPkg = project.storedPackages.get(
        structUtils.devirtualizeLocator(pkg).locatorHash,
      );
      if (!devirtPkg) {
        throw Error(
          `Assertion failed: The locator should have been registered`,
        );
      }

      collectTree(devirtPkg, out);
    }

    if (pkg.reference.startsWith("patch:")) {
      const depatchPkg = project.storedPackages.get(
        patchUtils.parseLocator(pkg).sourceLocator.locatorHash,
      );
      if (!depatchPkg) {
        throw Error(
          `Assertion failed: The locator should have been registered`,
        );
      }

      collectTree(depatchPkg, out);
    }

    for (const dependency of pkg.dependencies.values()) {
      const resolution = project.storedResolutions.get(
        dependency.descriptorHash,
      );
      if (!resolution) {
        throw Error(
          "Assertion failed: The descriptor should have been registered",
        );
      }

      const depPkg = project.storedPackages.get(resolution);
      if (!depPkg) {
        throw Error(
          `Assertion failed: The locator should have been registered`,
        );
      }

      collectTree(depPkg, out);
    }

    return out;
  };

  for (const locatorHash of project.storedBuildState.keys()) {
    const pkg = project.storedPackages.get(locatorHash as LocatorHash);
    if (!pkg) {
      throw Error(`Assertion failed: The locator should have been registered`);
    }

    // TODO: Better options for matching.
    if (!isolatedBuilds.includes(pkg.name)) {
      continue;
    }

    // TODO: We can't currently support the node-modules linker, because it
    // always clears build state.
    let installLocation: PortablePath;
    switch (nodeLinker) {
      case `pnp`:
        installLocation = ppath.relative(
          project.cwd,
          ppath.join(
            pnpUnpluggedFolder,
            structUtils.slugifyLocator(pkg),
            structUtils.getIdentVendorPath(pkg),
          ),
        );
        break;
      default:
        throw Error(
          `The nodeLinker ${nodeLinker} is not supported for isolated Nix builds`,
        );
    }

    // Virtualization typically happens when the package has peer dependencies,
    // and thus it depends on context how the package is built. But we
    // eliminate that context, so devirtualize.
    let devirtPkg = pkg;
    if (structUtils.isVirtualLocator(devirtPkg)) {
      const { locatorHash } = structUtils.devirtualizeLocator(devirtPkg);
      const pkg = project.storedPackages.get(locatorHash);
      if (!pkg) {
        throw Error(
          `Assertion failed: The locator should have been registered`,
        );
      }
      devirtPkg = pkg;
    }

    const buildLocatorStr = structUtils.stringifyLocator(devirtPkg);
    const injectLocatorStr = structUtils.stringifyLocator(pkg);
    const isolatedProp = `isolated.${json(buildLocatorStr)}`;

    if (!isolatedPackages.has(devirtPkg)) {
      isolatedPackages.add(devirtPkg);

      const args = [
        `pname = ${json(pkg.name)};`,
        `version = ${json(pkg.version)};`,
        `reference = ${json(devirtPkg.reference)};`,
      ];

      // If packaging deps individually, depend on just
      // the deps used during this isolated build.
      if (individualDrvs) {
        const locators = [...collectTree(pkg)]
          .sort()
          .map((v) => `${json(v)}\n`)
          .join(``);
        if (locators) {
          args.push(`locators = [\n${locators}];`);
        }
      }

      const overrideArg = `override${upperCamelize(pkg.name)}Attrs`;
      isolatedCode.push(
        `${isolatedProp} = optionalOverride (args.${overrideArg} or null) (mkIsolatedBuild { ${args.join(
          ` `,
        )} });`,
      );
    }

    if (isolatedIntegration.length === 0) {
      isolatedIntegration.push("# Copy in isolated builds.");
    }
    isolatedIntegration.push(
      `echo 'injecting build for ${pkg.name}'`,
      `yarn nixify inject-build \\`,
      `  ${json(injectLocatorStr)} \\`,
      `  $\{${isolatedProp}} \\`,
      `  ${json(installLocation)}`,
    );
  }
  if (isolatedIntegration.length > 0) {
    isolatedIntegration.push(`echo 'running yarn install'`);
  }

  // Render the Nix expression.
  //
  // If isolated builds are used, we rely on the build state, so don't render
  // if a special `--mode` was specified. This is because skipping builds may
  // give us an incomplete build state.
  if (opts.mode == null || isolatedBuilds.length === 0) {
    const ident = project.topLevelWorkspace.manifest.name;
    const projectName = ident ? structUtils.stringifyIdent(ident) : `workspace`;
    const projectExpr = renderTmpl(projectExprTmpl, {
      PROJECT_NAME: json(projectName),
      YARN_BIN: yarnBinExpr,
      LOCKFILE: lockfileExpr,
      INDIVIDUAL_DRVS: individualDrvs,
      COMBINED_DRV: !individualDrvs,
      COMBINED_HASH: combinedHash,
      CACHE_FOLDER: cacheFolderExpr,
      CACHE_ENTRIES: cacheEntriesCode,
      ISOLATED: isolatedCode.join("\n"),
      ISOLATED_INTEGRATION: indent("      ", isolatedIntegration.join("\n")),
      NEED_ISOLATED_BUILD_SUPPRORT: isolatedIntegration.length > 0,
      USES_PNP_LINKER: configuration.get("nodeLinker") === "pnp",
      USES_NM_LINKER: configuration.get("nodeLinker") === "node-modules",
    }).replace(/\n\n\n+/g, "\n\n");
    await xfs.writeFilePromise(nixExprPath, projectExpr);

    // Create a wrapper if it does not exist yet.
    if (configuration.get(`generateDefaultNix`)) {
      const defaultExprPath = ppath.join(cwd, `default.nix` as Filename);
      const flakeExprPath = ppath.join(cwd, `flake.nix` as Filename);
      if (!xfs.existsSync(defaultExprPath) && !xfs.existsSync(flakeExprPath)) {
        await xfs.writeFilePromise(defaultExprPath, defaultExprTmpl);
        report.reportInfo(
          0,
          `A minimal default.nix was created. You may want to customize it.`,
        );
      }
    }
  }

  // Preload the cache entries into the Nix store.
  if (
    configuration.get(`enableNixPreload`) &&
    xfs.existsSync(npath.toPortablePath(`/nix/store`))
  ) {
    await xfs.mktempPromise(async (tempDir) => {
      const args = ["--add-fixed", "sha512"];
      const toPreload: PortablePath[] = [];
      if (individualDrvs) {
        for (const [locator, { cachePath, hash }] of cacheEntries.entries()) {
          const name = sanitizeDerivationName(locator);
          // Check to see if the Nix store entry already exists.
          const storePath = computeFixedOutputStorePath(name, hash);
          if (!xfs.existsSync(storePath)) {
            // The nix-store command requires a correct filename on disk, so we
            // prepare a temporary directory containing all the files to preload.
            //
            // Because some names may conflict (e.g. 'typescript-npm-xyz' and
            // 'typescript-patch-xyz' both have the same derivation name), we
            // create subdirectories based on hash.
            const subdir = ppath.join(
              tempDir,
              sriToHex(hash).slice(0, 7) as Filename,
            );
            await xfs.mkdirPromise(subdir);

            const dst = ppath.join(subdir, name as Filename);
            await xfs.copyFilePromise(cachePath, dst);

            toPreload.push(dst);
          }
        }
      } else {
        args.unshift("--recursive");
        // Check to see if the Nix store entry already exists.
        const storePath = computeFixedOutputStorePath(
          "yarn-cache",
          combinedHash,
          { recursive: true },
        );
        if (!xfs.existsSync(storePath)) {
          // Same as above, nix-store requires a correct filename.
          const subdir = ppath.join(tempDir, "yarn-cache");
          await xfs.mkdirPromise(subdir);
          for (const [filename, { cachePath }] of cacheFiles.entries()) {
            const dst = ppath.join(subdir, filename);
            await xfs.copyFilePromise(cachePath, dst);
          }
          toPreload.push(subdir);
        }
      }

      try {
        // Preload in batches, to keep the exec arguments reasonable.
        const numToPreload = toPreload.length;
        while (toPreload.length !== 0) {
          const batch = toPreload.splice(0, 100);
          await execUtils.execvp("nix-store", [...args, ...batch], {
            cwd: project.cwd,
            strict: true,
          });
        }
        if (numToPreload !== 0) {
          report.reportInfo(
            0,
            individualDrvs
              ? `Preloaded ${numToPreload} packages into the Nix store`
              : `Preloaded cache into the Nix store`,
          );
        }
      } catch (err: any) {
        // Don't break if there appears to be no Nix installation after all.
        if (err.code !== "ENOENT") {
          throw err;
        }
      }
    });
  }
};
