import { Filename, npath, PortablePath, ppath, xfs } from "@yarnpkg/fslib";
import { computeFixedOutputStorePath } from "./nixUtils";

import {
  Cache,
  execUtils,
  LocatorHash,
  Project,
  Report,
  structUtils,
} from "@yarnpkg/core";

import defaultExprTmpl from "./tmpl/default.nix.in";
import projectExprTmpl from "./tmpl/yarn-project.nix.in";
import { tmpdir } from "os";

interface CacheEntry {
  name: string;
  filename: Filename;
  sha512: string;
  locatorHash: LocatorHash;
}

const cacheEntryToNix = (entry: CacheEntry) =>
  [
    `name = ${JSON.stringify(entry.name)};`,
    `filename = ${JSON.stringify(entry.filename)};`,
    `sha512 = ${JSON.stringify(entry.sha512)};`,
    `locatorHash = ${JSON.stringify(entry.locatorHash)};`,
  ].join(` `);

// Generator function that runs after `yarn install`.
export default async (project: Project, cache: Cache, report: Report) => {
  const { configuration, cwd } = project;

  // This case happens with `yarn dlx`, for example, and may cause errors if
  // special settings don't apply to those installations. (Like a `nixExprPath`
  // with a subdir that doesn't exist in the temporary project.)
  //
  // On macOS at least, we also need to get the real path of the OS temp dir,
  // because it goes through a symlink.
  const tempDir = xfs.realpathSync(npath.toPortablePath(tmpdir()));
  if (project.cwd.startsWith(tempDir)) {
    report.reportInfo(
      0,
      `Skipping Nixify, because ${project.cwd} appears to be a temporary directory`
    );
    return;
  }

  // Sanity checks.
  const yarnPathAbs = configuration.get(`yarnPath`);
  let yarnPath = ppath.relative(cwd, yarnPathAbs);
  if (yarnPath.startsWith(`../`)) {
    yarnPath = yarnPathAbs;
    report.reportWarning(
      0,
      `The Yarn path ${yarnPathAbs} is outside the project - it may not be reachable by the Nix build`
    );
  }

  const cacheFolderAbs = configuration.get(`cacheFolder`);
  let cacheFolder = ppath.relative(cwd, cacheFolderAbs);
  if (cacheFolder.startsWith(`../`)) {
    cacheFolder = cacheFolderAbs;
    report.reportWarning(
      0,
      `The cache folder ${cacheFolderAbs} is outside the project - it may not be reachable by the Nix build`
    );
  }

  for (const source of configuration.sources.values()) {
    if (!source.startsWith(`<`)) {
      const relativeSource = ppath.relative(cwd, source as PortablePath);
      if (relativeSource.startsWith(`../`)) {
        report.reportWarning(
          0,
          `The config file ${source} is outside the project - it may not be reachable by the Nix build`
        );
      }
    }
  }

  // Build a list of cache entries so Nix can fetch them.
  let cacheEntries: CacheEntry[] = [];
  const cacheFiles = new Set(xfs.readdirSync(cache.cwd));
  for (const pkg of project.storedPackages.values()) {
    const { version, locatorHash } = pkg;
    const checksum = project.storedChecksums.get(locatorHash);
    if (!checksum) continue;

    const cachePath = cache.getLocatorPath(pkg, checksum);
    if (!cachePath) continue;

    const filename = ppath.basename(cachePath);
    if (!cacheFiles.has(filename)) continue;

    let name = structUtils.slugifyIdent(pkg).replace(/^@/, "_at_");
    if (version) {
      name += `-${version}`;
    }

    const sha512 = checksum.split(`/`).pop()!;
    cacheEntries.push({ name, filename, sha512, locatorHash });
  }

  // Render the Nix expression.
  const ident = project.topLevelWorkspace.manifest.name;
  const projectName = ident ? structUtils.stringifyIdent(ident) : `workspace`;
  const projectExpr = projectExprTmpl
    .replace(`@@PROJECT_NAME@@`, JSON.stringify(projectName))
    .replace(`@@YARN_PATH@@`, JSON.stringify(yarnPath))
    .replace(`@@CACHE_FOLDER@@`, JSON.stringify(cacheFolder))
    .replace(
      `@@CACHE_ENTRIES@@`,
      `[\n` +
        cacheEntries
          .map((entry) => `    { ${cacheEntryToNix(entry)} }\n`)
          .sort()
          .join(``) +
        `  ]`
    );
  xfs.writeFileSync(configuration.get(`nixExprPath`), projectExpr);

  // Create a wrapper if it does not exist yet.
  if (configuration.get(`generateDefaultNix`)) {
    const defaultExprPath = ppath.join(cwd, `default.nix` as Filename);
    const flakeExprPath = ppath.join(cwd, `flake.nix` as Filename);
    if (!xfs.existsSync(defaultExprPath) && !xfs.existsSync(flakeExprPath)) {
      xfs.writeFileSync(defaultExprPath, defaultExprTmpl);
      report.reportInfo(
        0,
        `A minimal default.nix was created. You may want to customize it.`
      );
    }
  }

  // Preload the cache entries into the Nix store.
  if (
    configuration.get(`enableNixPreload`) &&
    xfs.existsSync(npath.toPortablePath(`/nix/store`))
  ) {
    await xfs.mktempPromise(async (tempDir) => {
      const toPreload: PortablePath[] = [];
      for (const { name, filename, sha512 } of cacheEntries) {
        // Check to see if the Nix store entry already exists.
        const hash = Buffer.from(sha512, "hex");
        const storePath = computeFixedOutputStorePath(name, `sha512`, hash);
        if (!xfs.existsSync(storePath)) {
          // The nix-store command requires a correct filename on disk, so we
          // prepare a temporary directory containing all the files to preload.
          //
          // Because some names may conflict (e.g. 'typescript-npm-xyz' and
          // 'typescript-patch-xyz' both have the same derivation name), we
          // create subdirectories based on hash.
          const subdir = ppath.join(tempDir, sha512.slice(0, 7) as Filename);
          await xfs.mkdirPromise(subdir);

          const src = ppath.join(cache.cwd, filename);
          const dst = ppath.join(subdir, name as Filename);
          await xfs.copyFilePromise(src, dst);

          toPreload.push(dst);
        }
      }

      try {
        // Preload in batches, to keep the exec arguments reasonable.
        const numToPreload = toPreload.length;
        while (toPreload.length !== 0) {
          const batch = toPreload.splice(0, 100);
          await execUtils.execvp(
            "nix-store",
            ["--add-fixed", "sha512", ...batch],
            {
              cwd: project.cwd,
              strict: true,
            }
          );
        }
        if (numToPreload !== 0) {
          report.reportInfo(
            0,
            `Preloaded ${numToPreload} packages into the Nix store`
          );
        }
      } catch (err) {
        // Don't break if there appears to be no Nix installation after all.
        if (err.code !== "ENOENT") {
          throw err;
        }
      }
    });
  }
};
