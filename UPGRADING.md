# Upgrade notes

This page lists significant changes to plugin functionality.

Upgrading the plugin is the same procedure as installing:

```sh
# Install the plugin
yarn plugin import https://raw.githubusercontent.com/stephank/yarn-plugin-nixify/main/dist/yarn-plugin-nixify.js

# Run Yarn as usual
yarn

# Build your project with Nix
nix-build
```

## Since 2757cfd (merged 2021-08-01)

- **BREAKING**: The plugin now requires Yarn v3.

## Since 153254f (merged 2021-04-30)

- **BREAKING**: The generated `yarn-project.nix` now takes an attribute set:

```nix
# Before
pkgs.callPackage ./yarn-project.nix { } ./.
# After
pkgs.callPackage ./yarn-project.nix { } { src = ./.; }
```

- **BREAKING**: The Yarn bundle and `yarn.lock` file are now directly
  referenced by the generated Nix code as a path literal. This change should
  not affect most regular Yarn installations, but may break if you're using a
  specialized build of Yarn.

- **BREAKING**: The derivations generated for downloading dependencies now have
  slightly different names, based on the Yarn locator format instead of a
  custom format. This unfortunately invalidates your Nix cache.

- As a convenience, an `overrideAttrs` option has been added, but both methods
  are still supported:

```nix
# Regular Nix-style:
(pkgs.callPackage ./yarn-project.nix { } { src = ./.; })
  .overrideAttrs (old: {
    name = "foobar";
  })

# New option:
pkgs.callPackage ./yarn-project.nix { } {
  src = ./.;
  overrideAttrs = old: {
    name = "foobar";
  };
}
```

- It is now possible to isolate builds of dependencies, allowing more
  fine-grained Nix cache. This is useful for e.g. modules with large native
  code builds. See [ISOLATED_BUILDS.md](./ISOLATED_BUILDS.md).
