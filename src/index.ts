import { Command } from "clipanion";
import { Filename, npath, ppath, xfs } from "@yarnpkg/fslib";
import { getPnpPath } from "@yarnpkg/plugin-pnp";

import {
  Cache,
  CommandContext,
  Configuration,
  Hooks,
  LocatorHash,
  Plugin,
  Project,
  Report,
  StreamReport,
  structUtils,
} from "@yarnpkg/core";

import binWrapperPnpTmpl from "./bin-wrapper-pnp.sh.in";
import binWrapperNodeModulesTmpl from "./bin-wrapper-node-modules.sh.in";
import defaultExprTmpl from "./default.nix.in";
import projectExprTmpl from "./yarn-project.nix.in";

const supportedLinkers = [`pnp`, `node-modules`];

// Generator function that runs after `yarn install`.
const generate = async (project: Project, cache: Cache, report: Report) => {
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
      const relativeSource = ppath.relative(cwd, source);
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

// Internal command that fetches a single locator.
// Used from within Nix to build the cache for the project.
class FetchOneCommand extends Command<CommandContext> {
  @Command.String()
  locatorHash: string = ``;

  @Command.Path(`nixify`, `fetch-one`)
  async execute() {
    const configuration = await Configuration.find(
      this.context.cwd,
      this.context.plugins
    );
    const { project } = await Project.find(configuration, this.context.cwd);
    const cache = await Cache.find(configuration);

    const fetcher = configuration.makeFetcher();

    const report = await StreamReport.start(
      { configuration, stdout: this.context.stdout },
      async (report) => {
        const pkg = project.originalPackages.get(
          this.locatorHash as LocatorHash
        );
        if (!pkg) {
          report.reportError(0, `Invalid locator hash`);
          return;
        }

        await fetcher.fetch(pkg, {
          checksums: project.storedChecksums,
          project,
          cache,
          fetcher,
          report,
        });
      }
    );

    return report.exitCode();
  }
}

// Internal command that creates wrappers for binaries.
// Used inside the Nix install phase.
class InstallBinCommand extends Command<CommandContext> {
  @Command.String()
  binDir: string = ``;

  @Command.Path(`nixify`, `install-bin`)
  async execute() {
    const configuration = await Configuration.find(
      this.context.cwd,
      this.context.plugins
    );
    const { project, workspace } = await Project.find(
      configuration,
      this.context.cwd
    );

    const report = await StreamReport.start(
      { configuration, stdout: this.context.stdout },
      async (report) => {
        if (!workspace || workspace.manifest.bin.size === 0) {
          return;
        }

        let nodeLinker = configuration.get(`nodeLinker`);
        if (!supportedLinkers.includes(nodeLinker)) {
          nodeLinker = `node-modules`;
          report.reportWarning(
            0,
            `The nodeLinker ${nodeLinker} is not supported - executables may have trouble finding dependencies`
          );
        }

        const binDir = npath.toPortablePath(this.binDir);
        const pnpPath = getPnpPath(project).main;
        for (const [name, scriptInput] of workspace.manifest.bin) {
          const binPath = ppath.join(binDir, name as Filename);
          const scriptPath = ppath.join(
            project.cwd,
            npath.toPortablePath(scriptInput)
          );

          let script;
          switch (nodeLinker) {
            case `pnp`:
              script = binWrapperPnpTmpl
                .replace(`@@PNP_PATH@@`, pnpPath)
                .replace(`@@SCRIPT_PATH@@`, scriptPath);
              break;
            case `node-modules`:
              script = binWrapperNodeModulesTmpl.replace(
                `@@SCRIPT_PATH@@`,
                scriptPath
              );
              break;
            default:
              throw Error(`Invalid nodeLinker ${nodeLinker}`);
          }

          xfs.writeFileSync(binPath, script);
          xfs.chmodSync(binPath, 0o755);
        }
      }
    );
  }
}

const plugin: Plugin<Hooks> = {
  commands: [FetchOneCommand, InstallBinCommand],
  hooks: {
    afterAllInstalled: async (project, opts) => {
      if (opts.persistProject !== false) {
        await generate(project, opts.cache, opts.report);
      }
    },
  },
};

export default plugin;
