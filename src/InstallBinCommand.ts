import { Command, Option } from "clipanion";
import { Filename, PortablePath, npath, ppath, xfs } from "@yarnpkg/fslib";
import { getPnpPath } from "@yarnpkg/plugin-pnp";
import { scriptUtils } from "@yarnpkg/core";

import {
  CommandContext,
  Configuration,
  Project,
  StreamReport,
} from "@yarnpkg/core";

import binWrapperNodeModulesTmpl from "./tmpl/bin-wrapper-node-modules.sh.in";
import binWrapperPnpTmpl from "./tmpl/bin-wrapper-pnp.sh.in";
import { renderTmpl } from "./textUtils";

const supportedLinkers = [`pnp`, `node-modules`];

// Internal command that creates wrappers for binaries.
// Used inside the Nix install phase.
export default class InstallBinCommand extends Command<CommandContext> {
  static paths = [[`nixify`, `install-bin`]];
  binDir = Option.String();

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
        if (!workspace) {
          return;
        }

        const binDir = npath.toPortablePath(this.binDir);

        for (const [name, binaryFile] of workspace.manifest.bin) {
          const wrapperPath = ppath.join(binDir, name as Filename);
          const binaryPath = ppath.join(
            project.cwd,
            npath.toPortablePath(binaryFile)
          );
          await this.writeWrapper(wrapperPath, binaryPath, {
            configuration,
            project,
          });
        }

        if (configuration.get(`installNixBinariesForDependencies`)) {
          await project.resolveEverything({ report, lockfileOnly: true });
          const binaries = await scriptUtils.getPackageAccessibleBinaries(
            project.topLevelWorkspace.anchoredLocator,
            { project }
          );
          for (const [name, [_, binaryPath]] of binaries.entries()) {
            const wrapperPath = ppath.join(binDir, name as Filename);
            await this.writeWrapper(
              wrapperPath,
              npath.toPortablePath(binaryPath),
              { configuration, project }
            );
          }
        }
      }
    );

    return report.exitCode();
  }

  private async writeWrapper(
    wrapperPath: PortablePath,
    binaryPath: PortablePath,
    {
      configuration,
      project,
    }: { configuration: Configuration; project: Project }
  ) {
    let wrapper;
    switch (configuration.get(`nodeLinker`)) {
      case `pnp`:
        wrapper = renderTmpl(binWrapperPnpTmpl, {
          NODE_PATH: process.execPath,
          PNP_PATH: getPnpPath(project).cjs,
          BINARY_PATH: binaryPath,
        });
        break;
      case `node-modules`:
        wrapper = renderTmpl(binWrapperNodeModulesTmpl, {
          NODE_PATH: process.execPath,
          BINARY_PATH: binaryPath,
        });
        break;
      default:
        throw Error(`Assertion failed: Invalid nodeLinker`);
    }

    await xfs.writeFilePromise(wrapperPath, wrapper);
    await xfs.chmodPromise(wrapperPath, 0o755);
  }
}
