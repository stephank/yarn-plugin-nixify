import FetchOneCommand from "./FetchOneCommand";
import InstallBinCommand from "./InstallBinCommand";
import generate from "./generate";
import { Hooks, Plugin, SettingsType } from "@yarnpkg/core";

const plugin: Plugin<Hooks> = {
  commands: [FetchOneCommand, InstallBinCommand],
  hooks: {
    afterAllInstalled: async (project, opts) => {
      if (
        opts.persistProject !== false &&
        project.configuration.get(`enableNixify`)
      ) {
        await generate(project, opts.cache, opts.report);
      }
    },
  },
  configuration: {
    enableNixify: {
      description: `If false, disables the Nixify plugin hook that generates Nix expressions`,
      type: SettingsType.BOOLEAN,
      default: true,
    },
    nixExprPath: {
      description: `Path of the file where the project Nix expression will be written to`,
      type: SettingsType.ABSOLUTE_PATH,
      default: `./yarn-project.nix`,
    },
    generateDefaultNix: {
      description: `If true, a default.nix will be generated if it does not exist`,
      type: SettingsType.BOOLEAN,
      default: true,
    },
    enableNixPreload: {
      description: `If true, cached packages will be preloaded into the Nix store`,
      type: SettingsType.BOOLEAN,
      default: true,
    },
  },
};

export default plugin;
