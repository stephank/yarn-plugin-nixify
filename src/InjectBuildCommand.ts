import { Command, Option } from "clipanion";
import { PortablePath, ppath, xfs } from "@yarnpkg/fslib";
import { createHash } from "crypto";

import {
  CommandContext,
  Configuration,
  execUtils,
  Locator,
  LocatorHash,
  Project,
  StreamReport,
  structUtils,
} from "@yarnpkg/core";

// Internal command that injects an isolated build inside a Nix build.
export default class InjectBuildCommand extends Command<CommandContext> {
  static paths = [[`nixify`, `inject-build`]];
  locator = Option.String();
  source = Option.String();
  installLocation = Option.String();

  async execute() {
    const configuration = await Configuration.find(
      this.context.cwd,
      this.context.plugins,
    );
    const { project } = await Project.find(configuration, this.context.cwd);

    await project.restoreInstallState({
      restoreResolutions: false,
    });
    const report = await StreamReport.start(
      { configuration, stdout: this.context.stdout },
      async (report) => {
        // To find virtualized packages, we need parse the lockfile.
        await project.resolveEverything({ report, lockfileOnly: true });

        const locator = structUtils.parseLocator(this.locator, true);
        const pkg = project.storedPackages.get(locator.locatorHash);
        if (!pkg) {
          report.reportError(0, `Invalid locator: ${this.locator}`);
          return;
        }

        // Copy over the build directory.
        // Can't use xfs.copyPromise, because it doesn't know how to deal with
        // the read-only permissions of our source path in the Nix store.
        const installLocation = ppath.join(
          project.cwd,
          this.installLocation as PortablePath,
        );
        await xfs.mkdirpPromise(ppath.dirname(installLocation));
        await execUtils.execvp("cp", ["-R", this.source, installLocation], {
          cwd: project.cwd,
          strict: true,
        });
        await execUtils.execvp("chmod", ["-R", "u+w", installLocation], {
          cwd: project.cwd,
          strict: true,
        });

        // Imitate Project: generate the global hash
        const globalHashGenerator = createHash(`sha512`);
        globalHashGenerator.update(process.versions.node);

        configuration.triggerHook(
          (hooks) => {
            return hooks.globalHashGeneration;
          },
          project,
          (data: Buffer | string) => {
            globalHashGenerator.update(`\0`);
            globalHashGenerator.update(data);
          },
        );

        const globalHash = globalHashGenerator.digest(`hex`);

        // Imitate Project: generate a package hash
        const packageHashMap = new Map<LocatorHash, string>();
        const getBaseHash = (locator: Locator) => {
          let hash = packageHashMap.get(locator.locatorHash);
          if (typeof hash !== `undefined`) return hash;

          const pkg = project.storedPackages.get(locator.locatorHash);
          if (typeof pkg === `undefined`)
            throw new Error(
              `Assertion failed: The package should have been registered`,
            );

          const builder = createHash(`sha512`);
          builder.update(locator.locatorHash);

          // To avoid the case where one dependency depends on itself somehow
          packageHashMap.set(locator.locatorHash, `<recursive>`);

          for (const descriptor of pkg.dependencies.values()) {
            const resolution = project.storedResolutions.get(
              descriptor.descriptorHash,
            );
            if (typeof resolution === `undefined`)
              throw new Error(
                `Assertion failed: The resolution (${structUtils.prettyDescriptor(
                  project.configuration,
                  descriptor,
                )}) should have been registered`,
              );

            const dependency = project.storedPackages.get(resolution);
            if (typeof dependency === `undefined`)
              throw new Error(
                `Assertion failed: The package should have been registered`,
              );

            builder.update(getBaseHash(dependency));
          }

          hash = builder.digest(`hex`);
          packageHashMap.set(locator.locatorHash, hash);

          return hash;
        };

        // Imitate Project: create a build hash that Yarn accepts
        const buildHash = createHash(`sha512`)
          .update(globalHash)
          .update(getBaseHash(pkg))
          .update(installLocation)
          .digest(`hex`);

        // Update build state. The way we do this is crude, but we run
        // `yarn install` later, which should clean it up again.
        project.storedBuildState.set(pkg.locatorHash, buildHash);
        await project.persistInstallStateFile();
      },
    );

    return report.exitCode();
  }
}
