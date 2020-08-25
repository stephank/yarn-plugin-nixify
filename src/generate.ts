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
  const yarnPathAbs = configuration.get(`yarnPath`);
  const cacheFolderAbs = configuration.get(`cacheFolder`);

  // Sanity checks.
  let yarnPath = ppath.relative(cwd, yarnPathAbs);
  if (yarnPath.startsWith(`../`)) {
    yarnPath = yarnPathAbs;
    report.reportWarning(
      0,
      `The Yarn path ${yarnPathAbs} is outside the project - it may not be reachable by the Nix build`
    );
  }

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
          .join(``) +
        `  ]`
    );
  const projectExprPath = ppath.join(cwd, `yarn-project.nix` as Filename);
  xfs.writeFileSync(projectExprPath, projectExpr);

  // Create a wrapper if it does not exist yet.
  const defaultExprPath = ppath.join(cwd, `default.nix` as Filename);
  if (!xfs.existsSync(defaultExprPath)) {
    xfs.writeFileSync(defaultExprPath, defaultExprTmpl);
    report.reportInfo(
      0,
      `A minimal default.nix was created. You may want to customize it.`
    );
  }

  // Preload the cache entries into the Nix store.
  if (xfs.existsSync(npath.toPortablePath(`/nix/store`))) {
    xfs.mktempPromise(async (tempDir) => {
      const toPreload: PortablePath[] = [];
      for (const { name, filename, sha512 } of cacheEntries) {
        // Check to see if the Nix store entry already exists.
        const hash = Buffer.from(sha512, "hex");
        const storePath = computeFixedOutputStorePath(name, `sha512`, hash);
        if (!xfs.existsSync(storePath)) {
          // The nix-store command requires a correct filename on disk, so we
          // prepare a temporary directory containing all the files to preload.
          const src = ppath.join(cache.cwd, filename);
          const dst = ppath.join(tempDir, name as Filename);
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
