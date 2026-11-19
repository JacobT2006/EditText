const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const yauzl = require('yauzl');
const { createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

// [Unused development flag] Intended to gate the commented-out developer-tools menu item below.
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

// [Core, all OS] Keep each window's open notes separate and track close confirmation.
const documentsByWindow = new Map();
const closeApproved = new WeakSet();
const closePending = new WeakSet();

// [Core, all OS] Defaults and bounds for persistent note editor preferences.
const defaultSettings = {
  autoSave: true,
  autoSaveDelay: 800,
  fontSize: 13,
  wordWrap: true,
};
let autoSaveEnabled = defaultSettings.autoSave;

// [Core, all OS] Validate font-size settings against the supported range.
const minFontSize = 4;
const maxFontSize = 124;
const pluginRepository = 'JacobT2006/editText-plugins';
let pluginCatalogCache = { expiresAt: 0, plugins: [] };

// [Core, all OS] Allow only supported menu commands to cross the IPC boundary.
const appCommands = new Set([
  'new',
  'open',
  'save',
  'save-as',
  'toggle-auto-save',
  'settings',
  'close-window',
]);

// CREATE OR RETURN THE NOTE STORE FOR A WINDOW.
function getWindowDocuments(webContents) {
  let documents = documentsByWindow.get(webContents.id);
  if (!documents) { // O(1)
    documents = new Map();
    documentsByWindow.set(webContents.id, documents);
    webContents.once('destroyed', () => documentsByWindow.delete(webContents.id));
  }
  return documents;
}

// SEND MENU ACTIONS TO THE FRONTMOST WINDOW.
function sendCommand(command) {
  let win = BrowserWindow.getFocusedWindow();
  if (!win) {
    win = BrowserWindow.getAllWindows()[0];
  }
  if (win && !win.isDestroyed()) { // O(1)
    win.webContents.send('app-command', command);
  }
}

// [Plugins, all OS] Keep installed plugin files and consent records in the user's app data folder.
function getPluginsDirectory() {
  return path.join(app.getPath('userData'), 'plugins');
}

function getPluginRegistryPath() {
  return path.join(app.getPath('userData'), 'plugins.json');
}

function isValidPluginId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,62}$/.test(id);
}

function validatePluginThemes(themes) {
  if (themes === undefined) {
    return [];
  }
  if (!Array.isArray(themes) || themes.length > 12) {
    throw new TypeError('Plugin themes must be an array with no more than 12 choices.');
  }
  const ids = new Set();
  return themes.map((theme) => {
    if (
      typeof theme?.id !== 'string'
      || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(theme.id)
      || ids.has(theme.id)
      || typeof theme.name !== 'string'
      || theme.name.trim().length === 0
      || theme.name.length > 40
    ) {
      throw new TypeError('Each plugin theme needs a unique valid ID and a name of at most 40 characters.');
    }
    ids.add(theme.id);
    return { id: theme.id, name: theme.name.trim() };
  });
}

function validatePluginFileTypes(fileTypes) {
  if (fileTypes === undefined) {
    return [];
  }
  if (!Array.isArray(fileTypes) || fileTypes.length > 32) {
    throw new TypeError('Plugin file types must be an array with no more than 32 entries.');
  }
  const extensions = new Set();
  return fileTypes.map((fileType) => {
    if (
      typeof fileType?.extension !== 'string'
      || !/^[a-z0-9][a-z0-9-]{0,15}$/.test(fileType.extension)
      || extensions.has(fileType.extension)
      || typeof fileType.name !== 'string'
      || fileType.name.trim().length === 0
      || fileType.name.length > 40
    ) {
      throw new TypeError('Each file type needs a unique extension and a name of at most 40 characters.');
    }
    extensions.add(fileType.extension);
    return { extension: fileType.extension, name: fileType.name.trim() };
  });
}

async function readPluginRegistry() {
  let contents;
  try {
    contents = await fs.readFile(getPluginRegistryPath(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const plugins = JSON.parse(contents);
  if (!Array.isArray(plugins)) {
    throw new TypeError('The installed plugin registry is invalid.');
  }
  return plugins.map((plugin) => {
    if (
      !isValidPluginId(plugin.id)
      || typeof plugin.name !== 'string'
      || typeof plugin.version !== 'string'
      || typeof plugin.description !== 'string'
      || !['ui', 'trusted'].includes(plugin.mode)
      || (plugin.enabled !== undefined && typeof plugin.enabled !== 'boolean')
    ) {
      throw new TypeError('The installed plugin registry contains an invalid entry.');
    }
    const themes = validatePluginThemes(plugin.themes);
    const fileTypes = validatePluginFileTypes(plugin.fileTypes);
    if (
      plugin.selectedTheme !== undefined
      && plugin.selectedTheme !== null
      && !themes.some((theme) => theme.id === plugin.selectedTheme)
    ) {
      throw new TypeError('The installed plugin registry contains an invalid theme selection.');
    }
    return {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      mode: plugin.mode,
      enabled: plugin.enabled !== false,
      themes,
      selectedTheme: themes.length > 0
        ? plugin.selectedTheme ?? themes[0].id
        : null,
      fileTypes,
    };
  });
}

function validatePluginStylesheet(stylesheet) {
  if (
    typeof stylesheet !== 'string'
    || Buffer.byteLength(stylesheet, 'utf8') > 1024 * 1024
    || /@import\b|url\s*\(/i.test(stylesheet)
  ) {
    throw new Error('UI plugins may use up to 1 MB of CSS, without imports or external resources.');
  }
}

async function readPluginStylesheet(id) {
  const stylesheetPath = path.join(getPluginsDirectory(), id, 'ui.css');
  const stylesheetStat = await fs.stat(stylesheetPath);
  if (!stylesheetStat.isFile() || stylesheetStat.size > 1024 * 1024) {
    throw new Error('UI plugin stylesheets must be regular files no larger than 1 MB.');
  }
  const stylesheet = await fs.readFile(stylesheetPath, 'utf8');
  validatePluginStylesheet(stylesheet);
  return stylesheet;
}

// [Plugins, all OS] Encode each GitHub path segment while preserving directory separators.
function encodeGitHubPath(value) {
  return value.split('/').map((part) => encodeURIComponent(part)).join('/');
}

// [Plugins, all OS] Fetch bounded JSON from GitHub with clear HTTP and network errors.
async function fetchGitHubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'EditText',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} while loading the plugin catalog.`);
  }
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > 10 * 1024 * 1024) {
    throw new Error('GitHub catalog data exceeds 10 MB.');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 10 * 1024 * 1024) {
    throw new Error('GitHub catalog data exceeds 10 MB.');
  }
  return JSON.parse(text);
}

// [Plugins, all OS] Discover plugin ZIPs in GitHub and decorate them with optional catalog metadata.
async function fetchPluginCatalog() {
  if (pluginCatalogCache.expiresAt > Date.now()) {
    const installed = new Set((await readPluginRegistry()).map((plugin) => plugin.id));
    return pluginCatalogCache.plugins.map((plugin) => ({
      ...plugin,
      installed: installed.has(plugin.id),
    }));
  }

  const repository = await fetchGitHubJson(`https://api.github.com/repos/${pluginRepository}`);
  const branch = repository.default_branch;
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new Error('The plugin repository does not have a default branch.');
  }
  const tree = await fetchGitHubJson(
    `https://api.github.com/repos/${pluginRepository}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  if (!Array.isArray(tree.tree) || tree.truncated) {
    throw new Error('The plugin repository catalog is too large to load.');
  }

  let metadataById = new Map();
  try {
    const metadataResponse = await fetch(
      `https://raw.githubusercontent.com/${pluginRepository}/${encodeGitHubPath(branch)}/catalog.json`,
      { headers: { 'User-Agent': 'EditText' }, signal: AbortSignal.timeout(15000) },
    );
    if (metadataResponse.ok) {
      const metadataText = await metadataResponse.text();
      if (Buffer.byteLength(metadataText, 'utf8') > 1024 * 1024) {
        throw new Error('The plugin catalog metadata exceeds 1 MB.');
      }
      const metadata = JSON.parse(metadataText);
      if (!Array.isArray(metadata.plugins)) {
        throw new TypeError('The plugin catalog metadata must contain a plugins array.');
      }
      metadataById = new Map(metadata.plugins.map((entry) => {
        if (
          !isValidPluginId(entry.id)
          || typeof entry.name !== 'string'
          || entry.name.trim().length === 0
          || entry.name.length > 80
          || typeof entry.description !== 'string'
          || entry.description.length > 500
          || (entry.author !== undefined && (typeof entry.author !== 'string' || entry.author.trim().length === 0 || entry.author.length > 80))
          || (entry.category !== undefined && (typeof entry.category !== 'string' || entry.category.trim().length === 0 || entry.category.length > 40))
          || (entry.version !== undefined && (typeof entry.version !== 'string' || entry.version.trim().length === 0 || entry.version.length > 40))
        ) {
          throw new TypeError('The plugin catalog contains an invalid entry.');
        }
        return [entry.id, entry];
      }));
    } else if (metadataResponse.status !== 404) {
      throw new Error(`GitHub returned ${metadataResponse.status} while loading catalog metadata.`);
    }
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('Timed out while loading plugin catalog metadata.');
    }
    throw error;
  }

  const plugins = tree.tree
    .filter((entry) => (
      entry.type === 'blob'
      && /^plugins\/[a-z0-9][a-z0-9._-]{0,62}\.zip$/i.test(entry.path)
    ))
    .map((entry) => {
      const id = path.posix.basename(entry.path).replace(/\.zip$/i, '').toLowerCase();
      const metadata = metadataById.get(id);
      const encodedPath = encodeGitHubPath(entry.path);
      return {
        id,
        name: metadata?.name ?? id.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
        version: metadata?.version?.trim() ?? 'Community',
        description: metadata?.description.trim() || 'Community extension. Review its source and permissions before installing.',
        author: metadata?.author?.trim() ?? 'Community contributor',
        category: metadata?.category?.trim() ?? 'Community',
        sourceUrl: `https://github.com/${pluginRepository}/blob/${encodeGitHubPath(branch)}/${encodedPath}`,
        downloadPath: entry.path,
        installed: false,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const installed = new Set((await readPluginRegistry()).map((plugin) => plugin.id));
  const catalog = plugins.map((plugin) => ({ ...plugin, installed: installed.has(plugin.id) }));
  pluginCatalogCache = { expiresAt: Date.now() + 5 * 60 * 1000, plugins: catalog };
  return catalog;
}

// [Plugins, all OS] Infer permissions from the package entry point before installing store downloads.
async function detectPluginMode(archivePath) {
  const archiveStat = await fs.stat(archivePath);
  if (archiveStat.size > 10 * 1024 * 1024) {
    throw new Error('Plugin ZIP files must be 10 MB or smaller.');
  }
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      let entryCount = 0;
      let hasStylesheet = false;
      let hasTrustedEntry = false;
      zipFile.on('error', reject);
      zipFile.on('entry', (entry) => {
        entryCount += 1;
        if (entryCount > 500) {
          zipFile.close();
          reject(new Error('Plugin ZIP files may contain at most 500 entries.'));
          return;
        }
        const parts = entry.fileName.replace(/\\/g, '/').split('/').filter(Boolean);
        hasStylesheet ||= parts.at(-1) === 'ui.css';
        hasTrustedEntry ||= parts.at(-1) === 'main.cjs';
        zipFile.readEntry();
      });
      zipFile.on('end', () => {
        if (hasStylesheet) {
          resolve('ui');
        } else if (hasTrustedEntry) {
          resolve('trusted');
        } else {
          reject(new Error('The plugin ZIP must contain ui.css or main.cjs.'));
        }
      });
      zipFile.readEntry();
    });
  });
}

async function writePluginRegistry(plugins) {
  const registryPath = getPluginRegistryPath();
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(plugins, null, 2), 'utf8');
    await fs.rename(temporaryPath, registryPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

// [Plugins, all OS] Extract a small ZIP package while rejecting traversal, links, and oversized archives.
async function extractPluginArchive(archivePath, destination) {
  const archiveStat = await fs.stat(archivePath);
  if (archiveStat.size > 10 * 1024 * 1024) {
    throw new Error('Plugin ZIP files must be 10 MB or smaller.');
  }

  await new Promise((resolve, reject) => {
    let zipFile;
    let settled = false;
    let entryCount = 0;
    let totalSize = 0;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      zipFile?.close();
      reject(error);
    };

    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true }, (error, openedZip) => {
      if (error) {
        fail(error);
        return;
      }
      zipFile = openedZip;
      zipFile.on('error', fail);
      zipFile.on('end', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      zipFile.on('entry', (entry) => {
        void (async () => {
          entryCount += 1;
          totalSize += entry.uncompressedSize;
          if (entryCount > 500 || totalSize > 20 * 1024 * 1024) {
            throw new Error('Plugin ZIP exceeds the allowed file count or expanded size.');
          }

          const entryName = entry.fileName.replace(/\\/g, '/');
          const entryParts = entryName.split('/').filter(Boolean);
          const targetPath = path.resolve(destination, ...entryParts);
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = mode & 0o170000;
          if (
            !entryName
            || entryName.includes('\0')
            || path.isAbsolute(entryName)
            || /^[a-z]:/i.test(entryName)
            || entryParts.includes('..')
            || (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000)
            || (targetPath !== destination && !targetPath.startsWith(`${destination}${path.sep}`))
          ) {
            throw new Error(`Plugin ZIP contains an unsafe path: ${entry.fileName}`);
          }

          if (entry.fileName.endsWith('/')) {
            await fs.mkdir(targetPath, { recursive: true });
          } else {
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            const input = await new Promise((streamResolve, streamReject) => {
              zipFile.openReadStream(entry, (streamError, stream) => {
                if (streamError) {
                  streamReject(streamError);
                } else {
                  streamResolve(stream);
                }
              });
            });
            await pipeline(input, createWriteStream(targetPath, { flags: 'wx', mode: 0o600 }));
          }
          zipFile.readEntry();
        })().catch(fail);
      });
      zipFile.readEntry();
    });
  });
}

async function findPluginPackageRoot(extractionDirectory) {
  try {
    await fs.access(path.join(extractionDirectory, 'manifest.json'));
    return extractionDirectory;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    const entries = await fs.readdir(extractionDirectory, { withFileTypes: true });
    const folders = entries.filter((entry) => (
      entry.isDirectory() && entry.name !== '__MACOSX'
    ));
    if (folders.length === 1) {
      const nestedRoot = path.join(extractionDirectory, folders[0].name);
      await fs.access(path.join(nestedRoot, 'manifest.json'));
      return nestedRoot;
    }
    throw new Error('Plugin ZIP must contain a manifest.json at its root.');
  }
}

// [Core, all OS] Create the shared editor window.
// [Platform UI] macOS keeps native traffic lights; Windows/Linux use custom frameless controls.
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 600,
    minHeight: 400,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 8, y: 10 },
        }
      : { frame: false }),
    title: 'EditText',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
// [Core, all OS] Stop throttleing and keep app running for cheap resources
  win.on('blur', () => {
    if (!win.isDestroyed()) {
      win.webContents.setBackgroundThrottling(true);
    }
  });
  win.on('focus', () => {
    if (!win.isDestroyed()) {
      win.webContents.setBackgroundThrottling(false);
    }
  });

  // [Windows/Linux] Hide the native menu bar because the app draws its own Notes menu.
  if (process.platform !== 'darwin') { //O(1)
    win.setMenuBarVisibility(false);
  }

  const sendMaximizeState = () => {
    if (!win.isDestroyed()) { //O(1)
      win.webContents.send('window-maximize-state', win.isMaximized());
    }
  };

  win.on('maximize', sendMaximizeState);
  win.on('unmaximize', sendMaximizeState);
  win.webContents.once('did-finish-load', sendMaximizeState);
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.on('context-menu', () => {
    if (!win.isDestroyed()) {
      contextMenu.popup({ window: win });
    }
  });

  win.on('close', (event) => {
    if (closeApproved.has(win)) { //O(1)
      return;
    }

    event.preventDefault();
    if (!closePending.has(win)) { //O(1)
      closePending.add(win);
      win.webContents.send('window-close-requested');
    }
  });

  return win;
}

// [Core, all OS] Provide native cut/copy/paste/select-all context actions.
// [Development only] The commented-out item can expose developer tools when enabled.
const contextMenu = Menu.buildFromTemplate([
  { role: 'cut' },
  { role: 'copy' },
  { role: 'paste' },
  { role: 'selectAll'}
  // { type: 'separator' },
  // {
  //   label: 'Toggle Developer Tools',
  //   enabled: isDev,
  //   accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
  //   click(_item, focusedWindow) {
  //     focusedWindow?.webContents.toggleDevTools();
  //   },
  // },
]);

// [Core, all OS] Keep the native menu's auto-save checkbox synchronized with preferences.
const autoSaveMenuItem = {
  label: 'Auto Save Notes',
  type: 'checkbox',
  checked: defaultSettings.autoSave,
  click: () => sendCommand('toggle-auto-save'),
};

// [Core, all OS] Native Notes menu; its accelerators use Command on macOS and Ctrl elsewhere.
const fileMenu = {
  label: 'Notes',
  submenu: [
    { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new') },
    { label: 'Open Notes…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open') },
    { type: 'separator' },
    autoSaveMenuItem,
    { type: 'separator' },
    { label: 'Save Note', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
    {
      label: 'Save Note As…',
      accelerator: 'CmdOrCtrl+Shift+S',
      click: () => sendCommand('save-as'),
    },
    { type: 'separator' },
    { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('close-window') },
  ],
};

const settingsMenu = {
  label: 'Settings',
  submenu: [
    { label: 'Settings…', click: () => sendCommand('settings') },
  ],
};

// [Platform UI] macOS adds its standard application menu; Windows/Linux rely on the in-window Notes menu.
const menuTemplate = [
  ...(process.platform === 'darwin'
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'forceReload' },
            { role: 'quit' },
          ],
        },
      ]
    : []),
  fileMenu,
  settingsMenu,
  { role: 'editMenu' },
  { role: 'viewMenu' },
  { role: 'windowMenu' },
];

// [Core, all OS] Perform window controls and gate closes until unsaved notes are handled.
ipcMain.handle('window-control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) { //O(1)
    return;
  }
  switch (action) { //O(1)
    case 'minimize':
      win.minimize();
      break;
    case 'toggle-maximize':
      win.isMaximized() ? win.unmaximize() : win.maximize();
      break;
    case 'confirm-close':
      closeApproved.add(win);
      closePending.delete(win);
      win.close();
      break;
    case 'cancel-close':
      closePending.delete(win);
      break;
    case 'request-close':
      win.close();
      break;
    default:
      throw new Error(`Unsupported window action: ${action}`);
  }
});

// [Core, all OS] Validate and forward menu commands to the requesting renderer.
ipcMain.handle('app:command', (event, command) => {
  if (!appCommands.has(command)) { //O(1)
    throw new Error(`Unsupported application command: ${command}`);
  }
  event.sender.send('app-command', command);
});

// [Plugins, all OS] List installed plugin metadata without exposing filesystem paths.
ipcMain.handle('plugins:list', async () => {
  const plugins = await readPluginRegistry();
  return Promise.all(plugins.map(async (plugin) => {
    if (plugin.mode !== 'ui') {
      return plugin;
    }
    try {
      const stylesheet = await fs.stat(path.join(getPluginsDirectory(), plugin.id, 'ui.css'));
      return {
        ...plugin,
        needsUpdate: !stylesheet.isFile() || stylesheet.size > 1024 * 1024,
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { ...plugin, needsUpdate: true };
      }
      throw error;
    }
  }));
});

// [Plugins, all OS] Return enabled CSS-only UI plugins; this API never reads or returns note data.
ipcMain.handle('plugins:styles', async () => {
  const plugins = await readPluginRegistry();
  const stylesheets = [];
  for (const plugin of plugins) {
    if (plugin.mode !== 'ui' || !plugin.enabled) {
      continue;
    }
    let stylesheet;
    try {
      stylesheet = await readPluginStylesheet(plugin.id);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    stylesheets.push({
      id: plugin.id,
      stylesheet,
      themes: plugin.themes,
      selectedTheme: plugin.selectedTheme,
    });
  }
  return stylesheets;
});

// [Plugins, all OS] Persist the selected theme offered by a CSS-only plugin.
ipcMain.handle('plugins:set-theme', async (_event, id, themeId) => {
  if (!isValidPluginId(id) || typeof themeId !== 'string') {
    throw new TypeError('A valid plugin ID and theme selection are required.');
  }
  const plugins = await readPluginRegistry();
  const pluginIndex = plugins.findIndex((installed) => installed.id === id);
  if (pluginIndex < 0) {
    throw new Error('This plugin is not installed.');
  }
  const plugin = plugins[pluginIndex];
  if (plugin.mode !== 'ui' || !plugin.themes.some((theme) => theme.id === themeId)) {
    throw new Error('This theme is not available for the selected plugin.');
  }
  const updatedPlugins = plugins.map((installed, index) => (
    index === pluginIndex ? { ...installed, selectedTheme: themeId } : installed
  ));
  await writePluginRegistry(updatedPlugins);
  return updatedPlugins[pluginIndex];
});

// [Plugins, all OS] Enable or disable a CSS-only plugin in the requesting app window.
ipcMain.handle('plugins:set-enabled', async (_event, id, enabled) => {
  if (!isValidPluginId(id) || typeof enabled !== 'boolean') {
    throw new TypeError('A valid plugin ID and enabled state are required.');
  }
  const plugins = await readPluginRegistry();
  const index = plugins.findIndex((plugin) => plugin.id === id);
  if (index < 0) {
    throw new Error('This plugin is not installed.');
  }
  const plugin = plugins[index];
  if (plugin.mode !== 'ui') {
    throw new Error('Only UI styling plugins can be enabled or disabled.');
  }
  if (enabled) {
    await readPluginStylesheet(id);
  }
  const updatedPlugins = plugins.map((installed, pluginIndex) => (
    pluginIndex === index ? { ...installed, enabled } : installed
  ));
  await writePluginRegistry(updatedPlugins);
  return updatedPlugins[index];
});

// [Plugins, all OS] Share archive validation, permission consent, and registration for local/store installs.
async function installPluginArchive(archivePath, mode, win, expectedId = null) {
  if (!['ui', 'trusted'].includes(mode)) {
    throw new TypeError('Choose UI styling/layout or trusted-code installation.');
  }

  const pluginsDirectory = getPluginsDirectory();
  await fs.mkdir(pluginsDirectory, { recursive: true });
  const stagingDirectory = await fs.mkdtemp(path.join(pluginsDirectory, '.install-'));
  try {
    await extractPluginArchive(archivePath, stagingDirectory);
    const packageRoot = await findPluginPackageRoot(stagingDirectory);
    const manifestPath = path.join(packageRoot, 'manifest.json');
    const manifestStat = await fs.stat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > 64 * 1024) {
      throw new Error('Plugin manifest.json must be a regular file no larger than 64 KB.');
    }

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (
      !isValidPluginId(manifest.id)
      || typeof manifest.name !== 'string'
      || manifest.name.trim().length === 0
      || manifest.name.length > 80
      || typeof manifest.version !== 'string'
      || manifest.version.trim().length === 0
      || manifest.version.length > 40
      || typeof manifest.description !== 'string'
      || manifest.description.length > 500
    ) {
      throw new TypeError('Plugin manifest must have a valid id, name, version, and description.');
    }
    const themes = validatePluginThemes(manifest.themes);
    const fileTypes = validatePluginFileTypes(manifest.fileTypes);
    if (themes.length > 0 && mode !== 'ui') {
      throw new TypeError('Theme choices are supported only by CSS styling plugins.');
    }
    if (fileTypes.length > 0 && mode !== 'trusted') {
      throw new TypeError('File-type handlers require trusted-code installation.');
    }
    if (expectedId && manifest.id !== expectedId) {
      throw new Error('The downloaded plugin ID does not match the catalog entry.');
    }

    const stylesheetPath = path.join(packageRoot, 'ui.css');
    const mainPath = path.join(packageRoot, 'main.cjs');
    const selectedEntryPath = mode === 'ui' ? stylesheetPath : mainPath;
    const selectedEntryStat = await fs.stat(selectedEntryPath).catch((error) => {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (!selectedEntryStat?.isFile()) {
      throw new Error(
        mode === 'ui'
          ? 'UI styling plugins must include ui.css.'
          : 'Full-trust plugins must include main.cjs.',
      );
    }
    if (mode === 'ui') {
      const stylesheet = await fs.readFile(stylesheetPath, 'utf8');
      validatePluginStylesheet(stylesheet);
    }
    if (mode === 'trusted' && selectedEntryStat.size > 2 * 1024 * 1024) {
      throw new Error('Full-trust plugin entry files must be 2 MB or smaller.');
    }

    if (mode === 'trusted') {
      const trustResult = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Install with full trust', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Trust this plugin?',
        message: `Allow ${manifest.name} to run trusted code?`,
        detail: fileTypes.length > 0
          ? 'This plugin can open and save files for its registered extensions and can access your files, network, and app APIs. Only install plugins from authors you trust.'
          : 'Its code can read and change the selected note and access your files, network, and app APIs. Only install plugins from authors you trust. It runs only when you choose Run with note access.',
      });
      if (trustResult.response !== 0) {
        return { canceled: true };
      }
    }

    const installedPlugins = await readPluginRegistry();
    if (installedPlugins.some((plugin) => plugin.id === manifest.id)) {
      throw new Error('A plugin with this ID is already installed. Remove it before installing another copy.');
    }
    if (fileTypes.length > 0) {
      const occupiedExtensions = new Map();
      for (const plugin of installedPlugins) {
        for (const fileType of plugin.fileTypes) {
          occupiedExtensions.set(fileType.extension, plugin.name);
        }
      }
      for (const fileType of fileTypes) {
        if (occupiedExtensions.has(fileType.extension)) {
          throw new Error(`.${fileType.extension} is already handled by ${occupiedExtensions.get(fileType.extension)}.`);
        }
      }
    }

    const targetDirectory = path.join(pluginsDirectory, manifest.id);
    try {
      await fs.access(targetDirectory);
      throw new Error('Plugin files already exist. Remove the existing plugin before reinstalling it.');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await fs.rename(packageRoot, targetDirectory);
    const installedPlugin = {
      id: manifest.id,
      name: manifest.name.trim(),
      version: manifest.version,
      description: manifest.description.trim(),
      mode,
      enabled: true,
      themes,
      selectedTheme: themes[0]?.id ?? null,
      fileTypes,
    };
    try {
      await writePluginRegistry([...installedPlugins, installedPlugin]);
    } catch (error) {
      await fs.rm(targetDirectory, { recursive: true, force: true });
      throw error;
    }
    return { canceled: false, plugin: installedPlugin };
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
  }
}

// [Plugins, all OS] Install a user-selected ZIP only after validating its manifest and requested trust level.
ipcMain.handle('plugins:install', async (event, mode) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    throw new Error('The plugin manager window is no longer available.');
  }
  const selection = await dialog.showOpenDialog(win, {
    title: 'Install plugin ZIP',
    properties: ['openFile'],
    filters: [{ name: 'Plugin ZIP packages', extensions: ['zip'] }],
  });
  if (selection.canceled || selection.filePaths.length === 0) {
    return { canceled: true };
  }
  return installPluginArchive(selection.filePaths[0], mode, win);
});

// [Plugins, all OS] Browse the public GitHub extension repository.
ipcMain.handle('plugins:catalog', async (_event, forceRefresh = false) => {
  if (typeof forceRefresh !== 'boolean') {
    throw new TypeError('The catalog refresh option must be a boolean.');
  }
  if (forceRefresh) {
    pluginCatalogCache.expiresAt = 0;
  }
  return fetchPluginCatalog();
});

// [Plugins, all OS] Download a repository-listed ZIP and install it with its inferred permission type.
ipcMain.handle('plugins:install-catalog', async (event, id) => {
  if (!isValidPluginId(id)) {
    throw new TypeError('Invalid plugin catalog ID.');
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    throw new Error('The plugin store window is no longer available.');
  }
  const plugin = (await fetchPluginCatalog()).find((entry) => entry.id === id);
  if (!plugin) {
    throw new Error('This plugin is no longer available in the catalog. Refresh the store and try again.');
  }
  const repository = await fetchGitHubJson(`https://api.github.com/repos/${pluginRepository}`);
  const downloadUrl = `https://raw.githubusercontent.com/${pluginRepository}/${encodeGitHubPath(repository.default_branch)}/${encodeGitHubPath(plugin.downloadPath)}`;
  const response = await fetch(downloadUrl, {
    headers: { 'User-Agent': 'EditText' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} while downloading ${plugin.name}.`);
  }
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > 10 * 1024 * 1024) {
    throw new Error('The plugin ZIP must be no larger than 10 MB.');
  }
  if (!response.body) {
    throw new Error('GitHub returned an empty plugin download.');
  }
  const chunks = [];
  let archiveSize = 0;
  for await (const chunk of response.body) {
    archiveSize += chunk.length;
    if (archiveSize > 10 * 1024 * 1024) {
      throw new Error('The plugin ZIP must be no larger than 10 MB.');
    }
    chunks.push(chunk);
  }
  if (archiveSize === 0) {
    throw new Error('The downloaded plugin ZIP is empty.');
  }
  const archive = Buffer.concat(chunks, archiveSize);
  const downloadDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'edittext-plugin-'));
  const archivePath = path.join(downloadDirectory, `${id}.zip`);
  try {
    await fs.writeFile(archivePath, archive, { flag: 'wx', mode: 0o600 });
    const mode = await detectPluginMode(archivePath);
    return await installPluginArchive(archivePath, mode, win, id);
  } finally {
    await fs.rm(downloadDirectory, { recursive: true, force: true });
  }
});

// [Plugins, all OS] Open the repository source for a catalog entry without treating metadata as a URL.
ipcMain.handle('plugins:open-catalog-item', async (_event, id) => {
  if (!isValidPluginId(id)) {
    throw new TypeError('Invalid plugin catalog ID.');
  }
  const plugin = (await fetchPluginCatalog()).find((entry) => entry.id === id);
  if (!plugin) {
    throw new Error('This plugin is no longer available in the catalog.');
  }
  await shell.openExternal(plugin.sourceUrl);
});

// [Plugins, all OS] Run trusted plugins with explicit access to the selected note.
ipcMain.handle('plugins:run', async (event, id, note, appContext = {}) => {
  if (!isValidPluginId(id)) {
    throw new TypeError('Invalid plugin ID.');
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  const plugin = (await readPluginRegistry()).find((installed) => installed.id === id);
  if (!win || !plugin) {
    throw new Error('This plugin is not installed or its window is unavailable.');
  }
  if (plugin.mode !== 'trusted') {
    throw new Error('UI styling plugins are applied from Settings and do not run code.');
  }
  const pluginDirectory = path.join(getPluginsDirectory(), plugin.id);
  const documents = getWindowDocuments(event.sender);
  const document = note && typeof note.id === 'string' ? documents.get(note.id) : null;
  if (!document || typeof note.content !== 'string' || Buffer.byteLength(note.content, 'utf8') > 10 * 1024 * 1024) {
    throw new Error('A valid open note is required to run this plugin.');
  }
  const openNotes = appContext?.notes;
  const appSettings = appContext?.settings;
  if (!Array.isArray(openNotes) || openNotes.length > 1000) {
    throw new TypeError('The plugin app context must contain the currently open notes.');
  }
  if (
    typeof appSettings?.autoSave !== 'boolean'
    || !Number.isInteger(appSettings.autoSaveDelay)
    || !Number.isInteger(appSettings.fontSize)
    || typeof appSettings.wordWrap !== 'boolean'
  ) {
    throw new TypeError('The plugin app context contains invalid application settings.');
  }
  let notesSize = 0;
  const noteSnapshots = openNotes.map((openNote) => {
    if (
      typeof openNote?.id !== 'string'
      || typeof openNote.name !== 'string'
      || typeof openNote.content !== 'string'
    ) {
      throw new TypeError('The plugin app context contains an invalid note.');
    }
    notesSize += Buffer.byteLength(openNote.content, 'utf8');
    if (notesSize > 20 * 1024 * 1024) {
      throw new Error('The currently open notes exceed the plugin context size limit.');
    }
    return { id: openNote.id, name: openNote.name, content: openNote.content };
  });

  const mainPath = path.join(pluginDirectory, 'main.cjs');
  const mainStat = await fs.stat(mainPath);
  if (!mainStat.isFile() || mainStat.size > 2 * 1024 * 1024) {
    throw new Error('The plugin main.cjs entry is missing or too large.');
  }
  const resolvedMainPath = require.resolve(mainPath);
  delete require.cache[resolvedMainPath];
  const pluginModule = require(resolvedMainPath);
  const run = typeof pluginModule === 'function' ? pluginModule : pluginModule.run;
  if (typeof run !== 'function') {
    throw new TypeError('A trusted plugin must export a function or a run function.');
  }
  const result = await run({
    note: {
      id: document.id,
      name: document.name,
      content: note.content,
    },
    app: {
      notes: noteSnapshots,
      settings: { ...appSettings },
      executeCommand: (command) => {
        if (!appCommands.has(command)) {
          throw new Error(`Unsupported application command: ${command}`);
        }
        win.webContents.send('app-command', command);
      },
    },
  });
  if (result === undefined) {
    return { content: null };
  }
  if (typeof result !== 'string' || Buffer.byteLength(result, 'utf8') > 10 * 1024 * 1024) {
    throw new TypeError('A plugin must return note text no larger than 10 MB, or return nothing.');
  }
  return { content: result };
});

// [Plugins, all OS] Remove an installed plugin.
ipcMain.handle('plugins:remove', async (_event, id) => {
  if (!isValidPluginId(id)) {
    throw new TypeError('Invalid plugin ID.');
  }
  const plugins = await readPluginRegistry();
  if (!plugins.some((plugin) => plugin.id === id)) {
    throw new Error('This plugin is not installed.');
  }
  const updatedPlugins = plugins.filter((plugin) => plugin.id !== id);
  await writePluginRegistry(updatedPlugins);
  try {
    await fs.rm(path.join(getPluginsDirectory(), id), { recursive: true, force: true });
  } catch (error) {
    await writePluginRegistry(plugins);
    throw error;
  }
  return updatedPlugins;
});

// [Plugins, all OS] Open the fixed community submission repository and bundled author guide.
ipcMain.handle('plugins:open-submissions', async () => {
  await shell.openExternal('https://github.com/JacobT2006/editText-plugins');
});
ipcMain.handle('plugins:open-guide', async () => {
  const error = await shell.openPath(path.join(__dirname, 'PLUGIN_GUIDE.md'));
  if (error) {
    throw new Error(`Could not open the plugin guide: ${error}`);
  }
});

async function getTrustedFormatPlugins() {
  const plugins = await readPluginRegistry();
  return plugins.filter((plugin) => plugin.mode === 'trusted' && plugin.fileTypes.length > 0);
}

async function loadTrustedFormatModule(plugin) {
  const mainPath = path.join(getPluginsDirectory(), plugin.id, 'main.cjs');
  const mainStat = await fs.stat(mainPath);
  if (!mainStat.isFile() || mainStat.size > 2 * 1024 * 1024) {
    throw new Error(`The file handler entry for ${plugin.name} is missing or too large.`);
  }
  const resolvedMainPath = require.resolve(mainPath);
  delete require.cache[resolvedMainPath];
  const pluginModule = require(resolvedMainPath);
  const formatHandlers = typeof pluginModule === 'function'
    ? null
    : pluginModule.formats ?? pluginModule;
  if (
    !formatHandlers
    || typeof formatHandlers.open !== 'function'
    || typeof formatHandlers.save !== 'function'
  ) {
    throw new TypeError(`${plugin.name} must export open and save file-format handlers.`);
  }
  return formatHandlers;
}

async function findFormatPlugin(extension) {
  const normalizedExtension = extension.replace(/^\./, '').toLowerCase();
  for (const plugin of await getTrustedFormatPlugins()) {
    if (plugin.fileTypes.some((fileType) => fileType.extension === normalizedExtension)) {
      return plugin;
    }
  }
  return null;
}

// [Core, all OS] Create an unsaved note in the requesting window's note store.
ipcMain.handle('note:new', (event) => {
  const document = { id: randomUUID(), filePath: null, name: 'Untitled.txt', content: '' };
  getWindowDocuments(event.sender).set(document.id, document);
  return { id: document.id, name: document.name, content: document.content, hasFile: false };
});

// [Core, all OS] Release the main-process note snapshot when its editor tab is closed.
ipcMain.handle('note:close', (event, id) => {
  if (typeof id !== 'string') {
    throw new TypeError('A note ID is required to close a note.');
  }
  const documents = getWindowDocuments(event.sender);
  if (!documents.delete(id)) {
    throw new Error('This note is no longer open.');
  }
  return true;
});

// [Core, all OS] Open text and trusted-plugin file types, converting plugin formats to editable text.
ipcMain.handle('note:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) { //O(1)
    return [];
  }

  const formatPlugins = await getTrustedFormatPlugins();
  const extensionFilters = formatPlugins.flatMap((plugin) => plugin.fileTypes.map((fileType) => ({
    name: fileType.name,
    extensions: [fileType.extension],
  })));
  const supportedExtensions = ['txt', ...extensionFilters.flatMap((filter) => filter.extensions)];
  const result = await dialog.showOpenDialog(win, {
    title: 'Open files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported files', extensions: supportedExtensions },
      { name: 'Text files', extensions: ['txt'] },
      ...extensionFilters,
    ],
  });
  if (result.canceled) { //O(1)
    return [];
  }

  const documents = getWindowDocuments(event.sender);
  const opened = [];
  for (const filePath of result.filePaths) { //O(N)
    const existing = [...documents.values()].find((document) => document.filePath === filePath);
    if (existing) { //O(1)
      opened.push({
        id: existing.id,
        name: existing.name,
        filePath: existing.filePath,
        content: existing.content,
        hasFile: true,
        lastSavedAt: existing.lastSavedAt,
      });
      continue;
    }
    const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
    let content;
    if (extension === 'txt') {
      content = await fs.readFile(filePath, 'utf8');
    } else {
      const plugin = await findFormatPlugin(extension);
      if (!plugin) {
        throw new Error(`No trusted plugin is installed for .${extension} files.`);
      }
      const handlers = await loadTrustedFormatModule(plugin);
      content = await handlers.open({
        filePath,
        name: path.basename(filePath),
        extension,
      });
      if (typeof content !== 'string') {
        throw new TypeError(`${plugin.name} returned non-text content when opening .${extension}.`);
      }
    }
    const lastSavedAt = (await fs.stat(filePath)).mtime.toISOString();
    const document = {
      id: randomUUID(),
      filePath,
      name: path.basename(filePath),
      content,
      lastSavedAt,
    };
    documents.set(document.id, document);
    opened.push({
      id: document.id,
      name: document.name,
      filePath: document.filePath,
      content: document.content,
      hasFile: true,
      lastSavedAt: document.lastSavedAt,
    });
  }
  return opened;
});

// [Core, all OS] Save note text as UTF-8, prompting with the OS save dialog when needed.
ipcMain.handle('note:save', async (event, {
  id,
  content,
  saveAs = false,
  automatic = false,
}) => {
  if ( // O(1)
    typeof id !== 'string'
    || typeof content !== 'string'
    || typeof automatic !== 'boolean'
  ) {
    throw new TypeError('A note id and text content are required to save a note.');
  }

  if (automatic && !autoSaveEnabled) { //O(1)
    return { canceled: true };
  }

  const documents = getWindowDocuments(event.sender);
  const document = documents.get(id);
  if (!document) { //O(1)
    throw new Error('This note is no longer open.');
  }

  let filePath = document.filePath;
  if (saveAs || !filePath) { //O(1)
    const win = BrowserWindow.fromWebContents(event.sender);
    const formatPlugins = await getTrustedFormatPlugins();
    const extensionFilters = formatPlugins.flatMap((plugin) => plugin.fileTypes.map((fileType) => ({
      name: fileType.name,
      extensions: [fileType.extension],
    })));
    const supportedExtensions = ['txt', ...extensionFilters.flatMap((filter) => filter.extensions)];
    const result = await dialog.showSaveDialog(win, {
      title: 'Save note',
      defaultPath: document.name === 'Untitled' ? 'Untitled.txt' : document.name,
      buttonLabel: 'Save',
      filters: [
        { name: 'Supported files', extensions: supportedExtensions },
        { name: 'Text files', extensions: ['txt'] },
        ...extensionFilters,
      ],
    });
    if (result.canceled || !result.filePath) { //O(1)
      return { canceled: true };
    }
    filePath = path.extname(result.filePath) ? result.filePath : `${result.filePath}.txt`;
  }

  if ([...documents.values()].some((openDocument) => openDocument.id !== id && openDocument.filePath === filePath)) {  //O(1)
    throw new Error('That note is already open in another tab.');
  }

  const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (extension === 'txt') {
    await fs.writeFile(filePath, content, 'utf8');
  } else {
    const plugin = await findFormatPlugin(extension);
    if (!plugin) {
      throw new Error(`No trusted plugin is installed for .${extension} files.`);
    }
    const handlers = await loadTrustedFormatModule(plugin);
    await handlers.save({
      filePath,
      name: path.basename(filePath),
      extension,
      content,
    });
  }
  const lastSavedAt = (await fs.stat(filePath)).mtime.toISOString();
  document.filePath = filePath;
  document.name = path.basename(filePath);
  document.content = content;
  document.lastSavedAt = lastSavedAt;
  return {
    canceled: false,
    name: document.name,
    filePath: document.filePath,
    hasFile: true,
    lastSavedAt,
  };
});

// [Core, all OS] Confirm whether to save, discard, or cancel closing a dirty note.
ipcMain.handle('note:confirm-close', async (event, name) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) { //O(1)
    return 'cancel';
  }
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save Note', "Don’t Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: `Save changes to note ${name}?`,
    detail: 'Unsaved changes will be lost if you close this note.',
  });
  return ['save', 'discard', 'cancel'][result.response];
});

// [Core, all OS] Load and normalize preferences from Electron's per-user data folder.
ipcMain.handle('settings:get', async () => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    const normalizedSettings = {
      autoSave: typeof settings.autoSave === 'boolean'
        ? settings.autoSave
        : defaultSettings.autoSave,
      autoSaveDelay: Number.isInteger(settings.autoSaveDelay)
        && settings.autoSaveDelay >= 250
        && settings.autoSaveDelay <= 10000
        ? settings.autoSaveDelay
        : defaultSettings.autoSaveDelay,
      fontSize: Number.isInteger(settings.fontSize)
        && settings.fontSize >= minFontSize
        && settings.fontSize <= maxFontSize
        ? settings.fontSize
        : defaultSettings.fontSize,
      wordWrap: settings.wordWrap !== false,
    };
    autoSaveEnabled = normalizedSettings.autoSave;
    return normalizedSettings;
  } catch (error) {
    if (error.code === 'ENOENT') { //O(1)
      autoSaveEnabled = defaultSettings.autoSave;
      return { ...defaultSettings };
    }
    throw error;
  }
});

// [Core, all OS] Validate and persist editor preferences.
ipcMain.handle('settings:set', async (_event, settings) => {
  if ( //O(1)
    typeof settings?.autoSave !== 'boolean'
    || !Number.isInteger(settings.autoSaveDelay)
    || settings.autoSaveDelay < 250
    || settings.autoSaveDelay > 10000
    || !Number.isInteger(settings.fontSize)
    || settings.fontSize < minFontSize
    || settings.fontSize > maxFontSize
    || typeof settings.wordWrap !== 'boolean'
  ) {
    throw new TypeError('The settings values are invalid.');
  }
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const savedSettings = {
    autoSave: settings.autoSave,
    autoSaveDelay: settings.autoSaveDelay,
    fontSize: settings.fontSize,
    wordWrap: settings.wordWrap,
  };
  await fs.writeFile(settingsPath, JSON.stringify(savedSettings, null, 2), 'utf8');
  autoSaveEnabled = savedSettings.autoSave;
  return savedSettings;
});

// [Core, all OS] Synchronize the native auto-save checkbox where that menu is visible.
ipcMain.on('settings:auto-save-menu-state', (_event, enabled) => {
  if (typeof enabled === 'boolean') { //O(1)
    autoSaveEnabled = enabled;
    autoSaveMenuItem.checked = enabled;
  }
});

// [Optional, packaged builds on all OS] Check the configured release feed from Settings.
ipcMain.handle('updates:check', async (event) => {
  if (!app.isPackaged) {
    return { status: 'unavailable', message: 'Updates are available in installed releases.' };
  }
  try {
    event.sender.send('updates:status', { status: 'checking', message: 'Checking for updates…' });
    await appUpdateChecker();
    return { status: 'checking', message: 'Checking for updates…' };
  } catch (error) {
    return { status: 'error', message: `Could not check for updates: ${error.message}` };
  }
});

// [Optional, packaged builds on all OS] Install an already-downloaded update and restart.
ipcMain.handle('updates:install', () => {
  if (!app.isPackaged) {
    return false;
  }
  autoUpdater.quitAndInstall();
  return true;
});


app.setName('EditText');
// [Linux desktop integration, non-core] Match the AppImage window identity to its desktop entry.
if (process.platform === 'linux') {
  app.setDesktopName('com.jacobt2006.edittext');
}
const appUpdateChecker = () => autoUpdater.checkForUpdates();
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// [Optional, all OS] Relay updater status to every open Settings window.
function sendUpdateStatus(status, message) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updates:status', { status, message });
    }
  }
}

autoUpdater.on('checking-for-update', () => {
  sendUpdateStatus('checking', 'Checking for updates…');
});
autoUpdater.on('update-available', () => {
  sendUpdateStatus('available', 'An update is available and is downloading…');
});
autoUpdater.on('update-not-available', () => {
  sendUpdateStatus('current', 'You’re using the latest version.');
});
autoUpdater.on('update-downloaded', () => {
  sendUpdateStatus('downloaded', 'Update downloaded. Restart the app to install it.');
});
autoUpdater.on('error', (error) => {
  sendUpdateStatus('error', `Update check failed: ${error.message}`);
});


// Test performance addition
app.disableHardwareAcceleration()
// [Core, all OS] Build the menu and create the initial window.
// [macOS] Recreate a window when the app is activated after all windows close.
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  createWindow();
  if (app.isPackaged) {
    appUpdateChecker().catch((error) => {
      sendUpdateStatus('error', `Update check failed: ${error.message}`);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) { //O(1)
      createWindow();
    }
  });
});

// [Platform lifecycle] macOS remains active without windows; Windows/Linux quit on last-window close.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { //O(1)
    app.quit();
  }
});
