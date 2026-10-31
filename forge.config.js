module.exports = {
    packagerConfig: {
      // Configuration for electron-packager
    },
    rebuildConfig: {},
    // PACKAGE THE APP FOR DESKTOP PLATFORMS.
    makers: [
      {
        name: '@electron-forge/maker-zip',
        platforms: ['darwin', 'linux', 'windows'], // Optional: target specific platforms
        config: {
          // Maker-specific configuration
        },
      },
      {
        name: '@electron-forge/maker-squirrel',
        config: {
          authors: 'JacobT2006',
          description: 'My application',
        },
      },
    ],
    // PUBLISH RELEASES TO THE CONFIGURED STORAGE BUCKET.
    publishers: [
      {
        name: '@electron-forge/publisher-s3',
        config: {
          bucket: 'my-app-releases',
          folder: 'releases',
        },
      },
    ],
    // BUILD THE MAIN AND RENDERER WINDOWS WITH WEBPACK.
    plugins: [
      {
        name: '@electron-forge/plugin-webpack',
        config: {
          mainConfig: './webpack.main.config.js',
          renderer: {
            config: './webpack.renderer.config.js',
            entryPoints: [
              {
                name: 'main_window',
                html: './src/renderer/index.html',
                js: './src/renderer/index.js',
                preload: {
                  js: './preload.js',
                },
              },
            ],
          },
        },
      },
    ],
    hooks: {
      // Custom hooks
    },
    buildIdentifier: 'edittext',
    outDir: 'dist',
  };
