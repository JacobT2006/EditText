<div align="center">
  <img src="Assets/AppIconRounded.svg" alt="EditText icon" width="128">
  <h1>EditText</h1>
  <p>A simple desktop app for writing and organizing plain-text notes.</p>
</div>

EditText is a desktop text editor built with Electron. It works with ordinary `.txt` files, so your notes stay SAVED!

## Table of Contents

- [Features](#features)
- [Install](#install)
- [Run from source](#run-from-source)
- [Contributing](#contributing)
  - [Branches](#branches)
  - [Development workflow](#development-workflow)
  - [Review and releases](#review-and-releases)
- [License](#license)


<!-- - [Use EditText](#use-edittext)
  - [Keyboard shortcuts](#keyboard-shortcuts) -->

## Features

- Create, open, and edit multiple plain-text notes in one window.
- Save notes to a chosen location, or enable auto-save for notes that already have a file.
- Search within the current note and move between matches.
- Reorder open notes and resize the notes explorer.
- Adjust auto-save timing, text size, and line wrapping in Settings.
- Check for and install app updates from Settings.
- Available for macOS, Windows, and Linux.

## Install

Download the latest release from the [EditText Releases page](https://github.com/JacobT2006/EditText/releases/latest), then follow the instructions for your operating system:

- **macOS:** Open the `.dmg` and drag EditText to Applications. If macOS blocks the app, use **System Settings → Privacy & Security** to allow it to open.
- **Windows:** Run the `-setup.exe` installer and follow its prompts.
- **Linux:** Download the `.AppImage`, make it executable if needed, and run it.

<!-- ## Use EditText

Choose **New Note** to start writing, or **Open Notes…** to open one or more `.txt` files. Select a note in the Explorer to switch between open notes. Use **Save Note** or **Save Note As…** to save your work. Auto-save is on by default for notes with a file location; change it from the Notes menu or Settings.

Use the search button in the left toolbar to find text in the current note. Settings also let you change the auto-save delay, note text size, and line wrapping. The Timeline shows when the current note was last saved.

### Keyboard shortcuts

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| New note | `⌘ N` | `Ctrl N` |
| Open notes | `⌘ O` | `Ctrl O` |
| Save note | `⌘ S` | `Ctrl S` |
| Save note as | `⌘ Shift S` | `Ctrl Shift S` |
| Close window | `⌘ W` | `Ctrl W` |
| Find next / previous match | `Enter` / `Shift Enter` while search is focused | `Enter` / `Shift Enter` while search is focused | -->

## Run from source

You need [Node.js](https://nodejs.org/) `26.10.0` or newer and npm. From the project directory:

```bash
npm ci
npm start
```

To create local release builds, run one of:

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

NOTE: Build output is written to `dist/`. Windows builds target x64; macOS and Linux builds use the host platform's default architecture.

## Contributing

Contributions are welcome. The `main` branch is protected, so changes are submitted through pull requests.

### Branches

| Branch | Purpose |
| --- | --- |
| `main` | Stable, released code. Protected: no direct pushes. |
| `Dev` | Integration branch. Feature branches are merged here first. |
| `feature/<short-name>` | New features (for example, `feature/word-count`). |
| `fix/<short-name>` | Bug fixes (for example, `fix/save-crash`). |

### Development workflow

1. Fork the repository, or clone it if you have write access.
2. Install Node.js `26.10.0` or newer, then install dependencies and launch the app:

   ```bash
   git clone https://github.com/<your-username>/EditText.git
   cd EditText
   nvm use          # uses the version in .nvmrc
   npm ci
   npm start
   ```

3. If you forked, add the original repository as `upstream`:

   ```bash
   git remote add upstream https://github.com/JacobT2006/EditText.git
   ```

4. Create a focused branch from the latest `Dev` branch:

   ```bash
   git fetch upstream       # use "origin" if you cloned the original repository
   git switch Dev
   git merge --ff-only upstream/Dev
   git switch -c feature/my-change
   ```

5. Run the app and check your change, then commit and push your branch:

   ```bash
   git add <files>
   git commit -m "Add a description"
   git push -u origin feature/my-change
   ```

6. Open a pull request with **base** set to `Dev`. Describe what changed and why, and include screenshots for UI changes.

GitHub Actions runs CodeQL on pull requests targeting `main`. The release workflow also runs CodeQL before building release installers. There is no configured automated test suite yet.

### Review and releases

Maintainers review and merge changes into `Dev`. To promote changes, maintainers open a pull request from `Dev` into `main`. The `main` branch requires one approving review, code owner review, passing required checks, and signed commits; use **Squash and merge** so GitHub signs the resulting commit.

Maintainers create releases from the **Actions** tab on the default branch by running the **Release** workflow and choosing a patch, minor, or major version bump. The workflow builds macOS, Windows, and Linux installers and publishes them to the [Releases page](https://github.com/JacobT2006/EditText/releases).

Release builds are unsigned and do not require certificates, notarization keys, or signing-related GitHub secrets. macOS and Windows may show security warnings for unsigned apps; users may need to explicitly allow the app to open or install it.

If `Dev` advances while your pull request is open, update your branch with:

```bash
git fetch upstream
git rebase upstream/Dev
git push --force-with-lease
```

## License

EditText is released under the [MIT License](LICENSE).
