import { Hooks, Plugin, SettingsType } from "@yarnpkg/core";
import { PortablePath } from "@yarnpkg/fslib";

import FetchCommand from "./FetchCommand";
import InjectBuildCommand from "./InjectBuildCommand";
import InstallBinCommand from "./InstallBinCommand";
import generate from "./generate";

declare module "@yarnpkg/core" {
  interface ConfigurationValueMap {
    enableNixify: boolean;
    nixExprPath: PortablePath;
    generateDefaultNix: boolean;
    enableNixPreload: boolean;
    individualNixPackaging: boolean;
    isolatedNixBuilds: string[];
    installNixBinariesForDependencies: boolean;
  }
}

const plugin: Plugin<Hooks> = {
  commands: [FetchCommand, InjectBuildCommand, InstallBinCommand],
  hooks: {
    afterAllInstalled: async (project, opts) => {
      if (
        opts.persistProject !== false &&
        project.configuration.get(`enableNixify`)
      ) {
        await generate(project, opts);
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
    individualNixPackaging: {
      description: `If true, generate one Nix derivation per package. If false, use a single derivation for the entire cache folder.`,
      type: SettingsType.BOOLEAN,
      default: false,
    },
    isolatedNixBuilds: {
      description: `Dependencies with a build step that can be built in an isolated derivation`,
      type: SettingsType.STRING,
      default: [],
      isArray: true,
    },
    installNixBinariesForDependencies: {
      description: `If true, the Nix output 'bin' directory will also contain executables for binaries defined by dependencies`,
      type: SettingsType.BOOLEAN,
      default: false,
    },
  },
};

export default plugin;
