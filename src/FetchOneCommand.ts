import { Command, Option } from "clipanion";

import {
  Cache,
  CommandContext,
  Configuration,
  Project,
  StreamReport,
  structUtils,
} from "@yarnpkg/core";

// Internal command that fetches a single locator.
// Used from within Nix to build the cache for the project.
export default class FetchOneCommand extends Command<CommandContext> {
  static paths = [[`nixify`, `fetch-one`]];
  locator = Option.String();

  async execute() {
    const configuration = await Configuration.find(
      this.context.cwd,
      this.context.plugins,
    );
    const { project } = await Project.find(configuration, this.context.cwd);
    const cache = await Cache.find(configuration);

    const fetcher = configuration.makeFetcher();

    const report = await StreamReport.start(
      { configuration, stdout: this.context.stdout },
      async (report) => {
        const { locatorHash } = structUtils.parseLocator(this.locator, true);
        const pkg = project.originalPackages.get(locatorHash);
        if (!pkg) {
          report.reportError(0, `Invalid locator`);
          return;
        }

        await fetcher.fetch(pkg, {
          checksums: project.storedChecksums,
          project,
          cache,
          fetcher,
          report,
        });
      },
    );

    return report.exitCode();
  }
}
