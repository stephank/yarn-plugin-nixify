# Isolated builds

The configuration option `isolatedNixBuilds` adds the ability to create a
separate Nix derivation for a dependency with a build step, which is then
copied into your regular project build. This allows Nix to cache the dependency
build, which is useful for e.g. large native code builds.

As an example, to create an isolated build of sqlite3, add the following to
your `.yarnrc.yml`:

```yml
individualNixPackaging: true
isolatedNixBuilds: ["sqlite3"]
```

(`individualNixPackaging` is required to use `isolatedNixBuilds`.)

In your Nix expression, separate options can be set to override attributes of
these derivations, which is often necessary to provide build inputs. For
sqlite3, you'd do the following in your `default.nix`:

```nix
{ pkgs ? import <nixpkgs> { } }:

pkgs.callPackage ./yarn-project.nix { } {
  src = ./.;
  overrideSqlite3Attrs = old: {
    npm_config_sqlite = "/";  # Don't accidentally use the wrong sqlite.
    buildInputs = old.buildInputs ++ (with pkgs; [ python3 sqlite ]);
  };
}
```

The general form of these options is `override<Package>Attrs` in camel-case.

## Technical details

For each package in `isolatedNixBuilds`, Nixify generates a derivation that
installs just that package in a temporary directory. Nixify reuses only your
Yarn bundle, your `yarn.lock` and a subset of your Yarn cache based on the
dependency tree of the package. (These are also the inputs that, when changed,
cause a rebuild.)

In your final project build, each of these isolated builds are copied in, and
Nixify tweaks the `.yarn/build-state.yml` file to hint Yarn it has already
completed this build.

## Limitations

- `nodeLinker: node-modules` is unfortunately not supported at this time.

- Peer dependencies are not considered, and isolated builds of packages with
  peer dependencies are currently not well tested.
