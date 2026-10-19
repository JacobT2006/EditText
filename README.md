# EditText

A desktop app for creating, editing, and organizing plain-text notes. Notes can be saved as `.txt` files.
The Timeline shows when the active note was last saved.

## Start the notes app

Requires Node.js 22.12.0 or newer.

```sh
npm install
npm start
```

## Run in production mode

```sh
npm run start:prod
```

Production mode disables development tools while still running the app from the
current source files.

## Package the app

Build installers and archives for macOS, Windows, and Linux:

```sh
npm run build:prod
```

To build for one platform, use `npm run build:mac`, `npm run build:win`, or
`npm run build:linux`. Build outputs are written to `dist/`. Cross-platform
packaging may require platform-specific tooling; for best results, build each
release on its target operating system. Windows packages target x64.
