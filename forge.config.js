module.exports = {
    packagerConfig: {
      // Configuration for electron-packager
    },
    rebuildConfig: {},
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
          certificateFile: './cert.pfx', // Example for Squirrel.Windows
          certificatePassword: process.env.CERTIFICATE_PASSWORD,
        },
      },
    ],
    publishers: [
      {
        name: '@electron-forge/publisher-s3',
        config: {
          bucket: 'my-app-releases',
          folder: 'releases',
        },
      },
    ],
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
    buildIdentifier: 'unix-notes',
    outDir: 'dist',
  };
