import { Command, Option } from "clipanion";

import {
  Cache,
  CommandContext,
  Configuration,
  Project,
  StreamReport,
  structUtils,
} from "@yarnpkg/core";

// Internal command that performs the fetch step.
// Used from within Nix to build the cache for the project.
export default class FetchCommand extends Command<CommandContext> {
  static paths = [[`nixify`, `fetch`]];
  locator = Option.String({ required: false });

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
        if (this.locator) {
          const { locatorHash } = structUtils.parseLocator(this.locator, true);
          const pkg = project.originalPackages.get(locatorHash);
          if (!pkg) {
            report.reportError(0, `Invalid locator: ${this.locator}`);
            return;
          }

          await fetcher.fetch(pkg, {
            checksums: project.storedChecksums,
            project,
            cache,
            fetcher,
            report,
          });
        } else {
          await report.startTimerPromise(`Resolution step`, async () => {
            await project.resolveEverything({ report, lockfileOnly: true });
          });
          await report.startTimerPromise(`Fetch step`, async () => {
            await project.fetchEverything({ cache, report, fetcher });
          });
        }
      },
    );

    return report.exitCode();
  }
}
