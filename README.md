# yarn-plugin-nixify

**WORK IN PROGRESS**

Generates a Nix expression to build a Yarn v2 package.

## Usage

```sh
yarn plugin import https://raw.githubusercontent.com/stephank/yarn-plugin-nixify/main/dist/yarn-plugin-nixify.js
yarn
yarn nixify
nix-build
```

The `yarn nixify` command always updates `yarn-project.nix`, but only writes a
(minimal) `default.nix` if it doesn't exist yet. The `default.nix` is intended
to be customized, for example:

```nix
{ pkgs ? import <nixpkgs> { } }:

let

  # Example of providing a different source.
  src = fetchFromGitHub {
    owner = "johndoe";
    repo = "myproject";
    rev = "v1.0.0";
    sha256 = "1hdhafj726g45gh7nj8qv1xls8mps3vhzq3aasdymbdqcb1clhkz";
  };

  project = pkgs.callPackage ./yarn-project.nix {

    # Example of selecting a specific version of Node.js.
    nodejs = pkgs.nodejs-14_x;

  } src;

in project.overrideAttrs (oldAttrs: {

  # Example of adding dependencies to the environment.
  # Native modules sometimes need these to build.
  buildInputs = oldAttrs.buildInputs ++ [ python3 ];

  # Example of invoking a build step in your project.
  buildPhase = ''
    yarn build
  '';

})
```

## Hacking

```sh
# In this directory:
yarn
yarn build-dev

# In your test project:
yarn plugin import /path/to/yarn-plugin-nixify/dist/yarn-plugin-nixify.dev.js
```

(Alternatively, add a direct reference in `.yarnrc.yml`.)
