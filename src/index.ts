import { Command } from "clipanion";
import { Filename, npath, ppath, xfs } from "@yarnpkg/fslib";
import { getPnpPath } from "@yarnpkg/plugin-pnp";

import {
  Cache,
  CommandContext,
  Configuration,
  Hooks,
  Plugin,
  Project,
  Report,
  StreamReport,
  execUtils,
  structUtils,
} from "@yarnpkg/core";

import binTmpl from "./bin-wrapper.sh.in";
import defaultExprTmpl from "./default.nix.in";
import projectExprTmpl from "./yarn-project.nix.in";

// Generator function that runs after `yarn install`.
const generate = async (project: Project, report: Report) => {
  const { configuration, cwd } = project;
  const yarnPathAbs = configuration.get(`yarnPath`);
  const lockfileFilename = configuration.get(`lockfileFilename`);

  // TODO: Should try to remove this. Our binary wrappers currently do
  // `node -r .pnp.js <bin>`, but not even sure if that's supported.
  if (configuration.get(`nodeLinker`) !== `pnp`) {
    report.reportWarning(
      0,
      `Currently, yarn-plugin-nixify only supports 'pnp' for the 'nodeLinker' setting.`
    );
    return;
  }

  let yarnPath = ppath.relative(cwd, yarnPathAbs);
  if (yarnPath.startsWith(`../`)) {
    yarnPath = yarnPathAbs;
    report.reportWarning(
      0,
      `The Yarn path ${yarnPathAbs} is outside the project directory - it cannot be reached by the Nix build`
    );
  }

  // List files the derivation will depend on.
  const yarnClosureInput = new Set([
    `package.json`,
    lockfileFilename,
    yarnPath,
  ]);
  for (const source of configuration.sources.values()) {
    if (!source.startsWith(`<`)) {
      yarnClosureInput.add(source);
    }
  }
  // TODO: Better way to find plugins? Re-parse rcfiles maybe?
  const pluginsDir = ppath.join(cwd, `.yarn/plugins` as Filename);
  if (xfs.existsSync(pluginsDir)) {
    for (const filename of xfs.readdirSync(pluginsDir)) {
      yarnClosureInput.add(ppath.join(pluginsDir, filename));
    }
  }

  // Build Nix `filterSource` entries to match on.
  const yarnClosureEntries = new Set();
  for (const inputPath of yarnClosureInput) {
    // Filter paths not reachable during the build and warn. (These are often
    // just user global configuration files, but the warnings can help highlight
    // dependencies on private registries.)
    const relativePath = ppath.relative(cwd, inputPath);
    if (relativePath.startsWith(`../`)) {
      if (inputPath !== yarnPath) {
        report.reportWarning(
          0,
          `The path ${inputPath} is outside the project directory and was ignored - it may not be reachable in the Nix build`
        );
      }
      continue;
    }
    // Add the file itself.
    yarnClosureEntries.add(`regular:${relativePath}`);
    // Add directories leading up to the file.
    let dir = ppath.dirname(relativePath);
    while (dir !== `.`) {
      yarnClosureEntries.add(`directory:${dir}`);
      dir = ppath.dirname(dir);
    }
  }

  // Build the Nix output-hash by hashing the Yarn cache folder. The
  // derivation should build the exact same.
  const cacheFolder = configuration.get(`cacheFolder`);
  let cacheHash = ``;
  try {
    const hasherResult = await execUtils.execvp(
      `nix-hash`,
      [`--type`, `sha256`, `--base32`, cacheFolder],
      { cwd, encoding: `utf8`, strict: true }
    );
    cacheHash = hasherResult.stdout.trim();
  } catch (err) {
    if (err.code === `ENOENT`) {
      report.reportWarning(
        0,
        `No Nix installation found - yarn-project.nix will not be updated`
      );
    } else {
      throw err;
    }
  }

  // Render the Nix expression.
  const ident = project.topLevelWorkspace.manifest.name;
  const projectName = ident ? structUtils.stringifyIdent(ident) : `workspace`;
  const projectExpr = projectExprTmpl
    .replace(`@@PROJECT_NAME@@`, JSON.stringify(projectName))
    .replace(`@@OFFLINE_CACHE_HASH@@`, JSON.stringify(cacheHash))
    .replace(`@@YARN_PATH@@`, JSON.stringify(yarnPath))
    .replace(
      `@@YARN_CLOSURE_ENTRIES@@`,
      `[ ` +
        [...yarnClosureEntries]
          .map((entry) => JSON.stringify(entry))
          .join(` `) +
        ` ]`
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

// Internal command that does just the fetch part of `yarn install`.
// Used inside the Nix offline-cache derivation to build the cache.
class BuildCacheCommand extends Command<CommandContext> {
  @Command.String()
  out: string = ``;

  @Command.Path(`nixify`, `build-cache`)
  async execute() {
    const configuration = await Configuration.find(
      this.context.cwd,
      this.context.plugins
    );

    // Overwrite the cache directory to our output directory.
    configuration.use(
      `<nixify>`,
      { cacheFolder: this.out },
      configuration.projectCwd!,
      { overwrite: true }
    );

    const { project } = await Project.find(configuration, this.context.cwd);
    const cache = await Cache.find(configuration);

    // Run resolution and fetch steps.
    const report = await StreamReport.start(
      { configuration, stdout: this.context.stdout },
      async (report) => {
        await report.startTimerPromise(`Resolution step`, () =>
          project.resolveEverything({ report, lockfileOnly: true })
        );
        await report.startTimerPromise(`Fetch step`, () =>
          project.fetchEverything({ cache, report })
        );
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

    if (workspace) {
      const binDir = npath.toPortablePath(this.binDir);
      const pnpPath = getPnpPath(project).main;
      for (const [name, scriptInput] of workspace.manifest.bin) {
        const binPath = ppath.join(binDir, name as Filename);
        const scriptPath = ppath.join(
          project.cwd,
          npath.toPortablePath(scriptInput)
        );
        const script = binTmpl
          .replace(`@@PNP_PATH@@`, pnpPath)
          .replace(`@@SCRIPT_PATH@@`, scriptPath);
        xfs.writeFileSync(binPath, script);
        xfs.chmodSync(binPath, 0o755);
      }
    }
  }
}

const plugin: Plugin<Hooks> = {
  commands: [BuildCacheCommand, FetchLocatorCommand, InstallBinCommand],
  hooks: {
    afterAllInstalled: async (project, opts) => {
      if (opts.persistProject !== false) {
        await generate(project, opts.report);
      }
    },
  },
};

export default plugin;
