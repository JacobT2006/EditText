# Creating an EditText plugin

Plugins can be browsed in the in-app **Extension Store** using the puzzle-piece button. The store loads ZIP packages from the public GitHub repository. Installed plugins and local ZIP installation remain available in **Settings → Plugins**. The installer offers two separate permission modes:

- **UI styling and layout:** applies `ui.css` to the EditText window. It can change the app's appearance and layout but cannot run plugin code, access notes or app APIs, or make network requests.
- **Trusted code:** runs `main.cjs` in the EditText main process when the user chooses **Run with note access**. It receives the selected note and can access the user's files, network, and app APIs. Only share this mode with code you trust.

UI styling plugins can be enabled or disabled in Settings. Trusted plugins show an additional warning before installation and run only after the user presses **Run with note access**.

## 1. Create a plugin folder

Create a folder such as `hello-plugin` with a `manifest.json` and one entry file. The manifest is required for both modes:

```json
{
  "id": "hello-plugin",
  "name": "Hello Plugin",
  "version": "1.0.0",
  "description": "A small example plugin."
}
```

The `id` must be lowercase letters, digits, dots, underscores, or hyphens, and must start with a letter or digit. Keep it unique. Names are limited to 80 characters and descriptions to 500 characters.

## 2. Choose a plugin type

### UI styling and layout plugin

Add `ui.css` beside `manifest.json`. The stylesheet is applied to EditText's main window, so it can restyle controls and adjust the app layout:

```css
/* Give the app a softer theme and widen the notes explorer. */
body {
  background: #202b38;
  color: #edf4fb;
}

.explorer {
  width: 300px;
}

button,
input,
textarea {
  border-radius: 8px;
}
```

UI plugins are CSS-only: JavaScript, HTML, and external resources are not accepted. The app rejects CSS `@import` and `url(...)` resources, and its content security policy blocks network access. CSS can change the look and arrangement of app UI, but cannot read or change note text.

### Trusted code plugin

Add `main.cjs` beside `manifest.json`:

```js
module.exports = async ({ note }) => {
  if (!note) {
    return;
  }

  // Return text to replace the active note, or return nothing to leave it unchanged.
  return note.content.toUpperCase();
};
```

The plugin receives a snapshot of the active note as `{ id, name, content }`. It may return a string to replace the note text, or return nothing to make no change. The user must have an active note open. The app marks returned text as an edit; the user's normal save and auto-save settings still apply.

Trusted code runs with Node.js privileges in the app process. It can read or write files, access the network, and call app APIs. Keep code small, explain its behavior, and never install it unless you trust its author.

## 3. Package and install

Put `manifest.json` and the selected entry file directly in the ZIP root. For example:

```text
hello-plugin.zip
├── manifest.json
└── ui.css
```

Or, for trusted code:

```text
hello-plugin.zip
├── manifest.json
└── main.cjs
```

Open **Settings → Plugins**, choose **UI styling and layout** or **Trusted code** for a local ZIP, and select **Install ZIP…**. In the Extension Store, choose **Install** on a listed plugin; EditText detects whether it is a CSS style or trusted-code plugin and checks permissions before installation. Trusted-code installation requires a separate confirmation. UI styles can be enabled or disabled; trusted plugins can be run with note access or removed. To replace a plugin version, remove the old one before installing the new ZIP.

Older UI plugins that contain `ui.html` must be removed and reinstalled as CSS-only packages with `ui.css`.

ZIP files may be at most 10 MB, expand to at most 20 MB, and contain at most 500 entries. Plugin IDs must be unique.

## 4. Submit a plugin

Use **Community plugins** in Settings → Plugins to open the community repository:
[JacobT2006/editText-plugins](https://github.com/JacobT2006/editText-plugins).

Submit a pull request containing the ZIP under `plugins/<plugin-id>.zip`. The Extension Store discovers ZIPs in that folder automatically. For a polished listing, add a root `catalog.json` with matching metadata:

```json
{
  "plugins": [
    {
      "id": "hello-plugin",
      "name": "Hello Plugin",
      "version": "1.0.0",
      "description": "A concise description shown on the store card.",
      "author": "Your name",
      "category": "Themes"
    }
  ]
}
```

The `id` must match the ZIP filename without `.zip`. Store descriptions and category names are plain text. Users can inspect the repository entry from each store card before installing.
