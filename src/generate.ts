import { Cache, Project, Report, structUtils } from "@yarnpkg/core";
import { Filename, PortablePath, ppath, xfs } from "@yarnpkg/fslib";

import defaultExprTmpl from "./tmpl/default.nix.in";
import projectExprTmpl from "./tmpl/yarn-project.nix.in";

// Generator function that runs after `yarn install`.
export default async (project: Project, cache: Cache, report: Report) => {
  const { configuration, cwd } = project;
  const yarnPathAbs = configuration.get(`yarnPath`);
  const cacheFolderAbs = configuration.get(`cacheFolder`);

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
  let cacheEntries = [];
  const cacheFiles = new Set(xfs.readdirSync(cache.cwd));
  for (const pkg of project.storedPackages.values()) {
    const checksum = project.storedChecksums.get(pkg.locatorHash);
    if (!checksum) continue;

    const cachePath = cache.getLocatorPath(pkg, checksum);
    if (!cachePath) continue;

    const filename = ppath.basename(cachePath);
    if (!cacheFiles.has(filename)) continue;

    let name = structUtils.slugifyIdent(pkg).replace(/^@/, "_at_");
    if (pkg.version) {
      name += `-${pkg.version}`;
    }

    const sha512 = checksum.split(`/`).pop();
    cacheEntries.push([
      `name = ${JSON.stringify(name)};`,
      `filename = ${JSON.stringify(filename)};`,
      `sha512 = ${JSON.stringify(sha512)};`,
      `locatorHash = ${JSON.stringify(pkg.locatorHash)};`,
    ]);
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
        [...cacheEntries]
          .map((entry) => `    { ${entry.join(` `)} }\n`)
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
};
