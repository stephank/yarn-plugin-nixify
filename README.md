# yarn-plugin-nixify

**Upgrading the plugin? See [UPGRADING.md](./UPGRADING.md)**

Generates a [Nix] expression to build a [Yarn] v3 project (not using
zero-install).

- Provides a `yarn` shell alias in the Nix builder — no global Yarn v1 install
  needed.

- A default configure-phase that runs `yarn` in your project. (May be all
  that's needed for plain JavaScript projects.)

- A default install-phase that creates executables for you based on `"bin"` in
  your `package.json`, making your package readily installable.

- Granular fetching of dependencies in Nix, speeding up rebuilds and
  potentially allowing downloads to be shared between projects.

- Preloading of your Yarn cache into the Nix store, speeding up local
  `nix-build`.

- Automatically keeps your Nix expression up-to-date as you `yarn add` /
  `yarn remove` dependencies.

- **No Nix installation required** for the plugin itself, so it should be safe
  to add to your project even if some developers don't use Nix.

[nix]: https://nixos.org
[yarn]: https://yarnpkg.com

Related projects:

- [node2nix], [yarn2nix]: Both do a similar job, but as separate commands. By
  comparison, this plugin tries to automate the process and make things easy
  for Nix and non-Nix devs alike.

- [composer-plugin-nixify]: Similar solution for PHP with Composer.

[node2nix]: https://github.com/svanderburg/node2nix
[yarn2nix]: https://github.com/nix-community/yarn2nix/
[composer-plugin-nixify]: https://github.com/stephank/composer-plugin-nixify

## Usage

The minimum version of Yarn is 3.1.0. Run the following in your project folder
to check:

```sh
# Check your Yarn version
yarn --version

# Upgrade to the latest version, if necessary
yarn set version berry
```

To then use the Nixify plugin:

```sh
# Install the plugin
yarn plugin import https://raw.githubusercontent.com/stephank/yarn-plugin-nixify/main/dist/yarn-plugin-nixify.js

# Run Yarn as usual
yarn

# Build your project with Nix
nix-build
```

Running `yarn` with this plugin enabled will generate two files:

- `yarn-project.nix`: This file is always overwritten, and contains a basic
  derivation for your project.

- `default.nix`: Only generated if it does not exist yet. This file is intended
  to be customized with any project-specific logic you need.

This may already build successfully! But if your project needs extra build
steps or native dependencies, you may have to customize `default.nix` a bit.
Some examples of what's possible:

```nix
{ pkgs ? import <nixpkgs> { } }:

let

  project = pkgs.callPackage ./yarn-project.nix {

    # Example of selecting a specific version of Node.js.
    nodejs = pkgs.nodejs-14_x;

  } {

    # Example of providing a different source tree.
    src = pkgs.lib.cleanSource ./.;

  }

in project.overrideAttrs (oldAttrs: {

  # If your top-level package.json doesn't set a name, you can set one here.
  name = "myproject";

  # Example of adding packages to the build environment.
  # Especially dependencies with native modules may need a Python installation.
  buildInputs = oldAttrs.buildInputs ++ [ pkgs.python3 ];

  # Example of invoking a build step in your project.
  buildPhase = ''
    yarn build
  '';

})
```

## Settings

Some additional settings are available in `.yarnrc.yml`:

- `nixExprPath` can be set to customize the path where the Nixify plugin writes
  `yarn-project.nix`. For example, if you're also using [Niv] in your project,
  you may prefer to set this to `nix/yarn-project.nix`.

- `generateDefaultNix` can be set to `false` to disable generating a
  `default.nix`. This file is only generated if it doesn't exist yet, but this
  flag can be useful if you don't want a `default.nix` at all.

- `enableNixPreload` can be set to `false` to disable preloading Yarn cache
  into the Nix store. This preloading is intended to speed up a local
  `nix-build`, because Nix will not have to download dependencies again.
  Preloading does mean another copy of dependencies on disk, even if you don't
  do local Nix builds, but the size is usually not an issue on modern disks.

- `isolatedNixBuilds`, see [ISOLATED_BUILDS.md](./ISOLATED_BUILDS.md).

- `installNixBinariesForDependencies` can be set to also install executables
  for binaries defined by dependencies. This can be useful if these need to be
  in `$PATH` for other tools, or if you're creating a workspace just to collect
  command-line tools.

[niv]: https://github.com/nmattia/niv

## Hacking

```sh
# In this directory:
yarn
yarn build-dev

# In your test project:
yarn plugin import /path/to/yarn-plugin-nixify/dist/yarn-plugin-nixify.dev.js
```

(Alternatively, add a direct reference in `.yarnrc.yml`. This will likely only
work if the Nix sandbox is disabled.)
