import { Command } from "clipanion";

import {
  Cache,
  CommandContext,
  Configuration,
  LocatorHash,
  Project,
  StreamReport,
} from "@yarnpkg/core";

// Internal command that fetches a single locator.
// Used from within Nix to build the cache for the project.
export default class FetchOneCommand extends Command<CommandContext> {
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
