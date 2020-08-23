#!/usr/bin/env node

// TODO: This borrows from '@yarnpkg/builder', but the only thing we add here
// is raw-loader for '.in` files.

const webpack = require(`webpack`);
const { RawSource } = require(`webpack-sources`);

const IS_PROD = process.argv[2] === `-p`;
const EXTERNALS = [
  `@yarnpkg/cli`,
  `@yarnpkg/core`,
  `@yarnpkg/fslib`,
  `@yarnpkg/plugin-pnp`,
  `clipanion`,
];

const compiler = webpack({
  context: __dirname,
  entry: `.`,

  mode: IS_PROD ? `production` : `development`,
  devtool: false,

  node: {
    __dirname: false,
    __filename: false,
  },

  output: {
    filename: IS_PROD ? `yarn-plugin-nixify.js` : `yarn-plugin-nixify.dev.js`,
    libraryTarget: `var`,
    library: `plugin`,
  },

  resolve: {
    extensions: [`.mjs`, `.js`, `.ts`, `.tsx`, `.json`],
  },

  externals: Object.fromEntries(
    EXTERNALS.map((name) => [name, `commonjs ${name}`])
  ),

  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: `babel-loader`,
        options: {
          plugins: [
            [`@babel/plugin-proposal-decorators`, { legacy: true }],
            [`@babel/plugin-proposal-class-properties`, { loose: true }],
          ],
          presets: ["@babel/preset-typescript"],
        },
      },
      {
        test: /\.in$/,
        loader: `raw-loader`,
      },
    ],
  },

  plugins: [
    // This plugin wraps the generated bundle so that it doesn't actually
    // get evaluated right now - until after we give it a custom require
    // function that will be able to fetch the dynamic modules.
    {
      apply: (compiler) => {
        compiler.hooks.compilation.tap(`WrapYarn`, (compilation) => {
          compilation.hooks.processAssets.tap(
            {
              name: `WrapYarn`,
              stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS,
            },
            (assets) => {
              for (const file in assets) {
                assets[file] = new RawSource(
                  [
                    `module.exports = {`,
                    `name: "yarn-plugin-nixify",`,
                    `factory: function (require) {`,
                    assets[file].source(),
                    `return plugin;`,
                    `}`,
                    `};`,
                  ].join(`\n`)
                );
              }
            }
          );
        });
      },
    },
  ],
});

compiler.run((err, stats) => {
  if (err) {
    console.error(err);
    process.exit(1);
  } else if (stats && stats.compilation.errors.length > 0) {
    console.error(stats.toString(`errors-only`));
    process.exit(1);
  }
});
