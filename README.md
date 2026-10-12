# Unix Notes

A desktop notes app built with Electron.

## Run

Requires Node.js 22.12.0 or newer.

```sh
npm install
npm start
```

Create notes with **File > New Note**, open one or more `.txt` files with **File > Open…**, and use **Save** or **Save As…** to write UTF-8 text files. Notes appear in the Explorer's **Open Editors** list; close buttons are available beside each note. Closing a changed note prompts to save, discard, or cancel.

**File > Settings…** controls auto-save, auto-save delay, editor text size, and line wrapping. Auto-save is off by default. When enabled, changes to saved files are written after the selected delay; new notes need an initial Save or Save As.

The Explorer's **Open Editors** and **Timeline** sections can be collapsed. Timeline lists recent text additions made to the active note during the current session.

Use the activity-bar search action to find text in the current note.