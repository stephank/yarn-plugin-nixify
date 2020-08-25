import FetchOneCommand from "./FetchOneCommand";
import InstallBinCommand from "./InstallBinCommand";
import generate from "./generate";
import { Hooks, Plugin } from "@yarnpkg/core";

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
