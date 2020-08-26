import { Command } from "clipanion";
import { Filename, npath, ppath, xfs } from "@yarnpkg/fslib";
import { getPnpPath } from "@yarnpkg/plugin-pnp";

import {
  CommandContext,
  Configuration,
  Project,
  StreamReport,
} from "@yarnpkg/core";

import binWrapperNodeModulesTmpl from "./tmpl/bin-wrapper-node-modules.sh.in";
import binWrapperPnpTmpl from "./tmpl/bin-wrapper-pnp.sh.in";

const supportedLinkers = [`pnp`, `node-modules`];

// Internal command that creates wrappers for binaries.
// Used inside the Nix install phase.
export default class InstallBinCommand extends Command<CommandContext> {
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
                .replace(`@@NODE_PATH@@`, process.execPath)
                .replace(`@@PNP_PATH@@`, pnpPath)
                .replace(`@@SCRIPT_PATH@@`, scriptPath);
              break;
            case `node-modules`:
              script = binWrapperNodeModulesTmpl
                .replace(`@@NODE_PATH@@`, process.execPath)
                .replace(`@@SCRIPT_PATH@@`, scriptPath);
              break;
            default:
              throw Error(`Invalid nodeLinker ${nodeLinker}`);
          }

          xfs.writeFileSync(binPath, script);
          xfs.chmodSync(binPath, 0o755);
        }
      }
    );

    return report.exitCode();
  }
}
