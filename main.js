const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

// KEEP EACH WINDOW'S OPEN NOTES SEPARATE.
const documentsByWindow = new Map();
const closeApproved = new WeakSet();
const closePending = new WeakSet();

// SET DEFAULT NOTE DISPLAY AND SAVE PREFERENCES.
const defaultSettings = {
  autoSave: true,
  autoSaveDelay: 800,
  fontSize: 13,
  wordWrap: true,
};
let autoSaveEnabled = defaultSettings.autoSave;

// LIMIT THE NOTE FONT SIZE TO A READABLE RANGE.
const minFontSize = 4;
const maxFontSize = 124;

// ACCEPT ONLY COMMANDS USED BY THE APP MENUS.
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
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed()) { // O(1)
    win.webContents.send('app-command', command);
  }
}

// CREATE THE WINDOW AND CONFIGURE ITS PLATFORM CHROME.
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

// PROVIDE BASIC TEXT EDITING AND DEVELOPMENT CONTEXT ACTIONS.
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

// KEEP THE AUTO-SAVE MENU CHECKBOX IN SYNC WITH SETTINGS.
const autoSaveMenuItem = {
  label: 'Auto Save Notes',
  type: 'checkbox',
  checked: defaultSettings.autoSave,
  click: () => sendCommand('toggle-auto-save'),
};

// DEFINE NOTE, SAVE, SETTINGS, AND WINDOW COMMANDS.
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

// BUILD THE NATIVE APPLICATION MENU.
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

// HANDLE WINDOW ACTIONS REQUESTED BY THE RENDERER.
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

// VALIDATE AND FORWARD APP MENU COMMANDS.
ipcMain.handle('app:command', (event, command) => {
  if (!appCommands.has(command)) { //O(1)
    throw new Error(`Unsupported application command: ${command}`);
  }
  event.sender.send('app-command', command);
});

// CREATE A NEW UNSAVED NOTE.
ipcMain.handle('note:new', (event) => {
  const document = { id: randomUUID(), filePath: null, name: 'Untitled.txt', content: '' };
  getWindowDocuments(event.sender).set(document.id, document);
  return { id: document.id, name: document.name, content: document.content, hasFile: false };
});

// OPEN TEXT NOTES AND REUSE ALREADY OPEN NOTES.
ipcMain.handle('note:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) { //O(1)
    return [];
  }

  const result = await dialog.showOpenDialog(win, {
    title: 'Open notes',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Text files', extensions: ['txt'] }],
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
    const content = await fs.readFile(filePath, 'utf8');
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

// SAVE A NOTE TO ITS CURRENT OR A NEW TEXT FILE.
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
    const result = await dialog.showSaveDialog(win, {
      title: 'Save note',
      defaultPath: document.name === 'Untitled' ? 'Untitled.txt' : document.name,
      buttonLabel: 'Save',
      filters: [{ name: 'Text files', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) { //O(1)
      return { canceled: true };
    }
    filePath = path.extname(result.filePath)
      ? result.filePath
      : `${result.filePath}.txt`;
  }

  if ([...documents.values()].some((openDocument) => openDocument.id !== id && openDocument.filePath === filePath)) {  //O(1)
    throw new Error('That note is already open in another tab.');
  }

  await fs.writeFile(filePath, content, 'utf8');
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

// ASK BEFORE CLOSING A NOTE WITH UNSAVED CHANGES.
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

// LOAD SAVED PREFERENCES AND APPLY SAFE DEFAULTS.
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

// VALIDATE AND PERSIST NOTE EDITOR PREFERENCES.
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

// UPDATE THE NATIVE MENU CHECKBOX FROM THE RENDERER.
ipcMain.on('settings:auto-save-menu-state', (_event, enabled) => {
  if (typeof enabled === 'boolean') { //O(1)
    autoSaveEnabled = enabled;
    autoSaveMenuItem.checked = enabled;
  }
});


app.setName('EditText');

// START THE APP AND RESTORE ITS WINDOW WHEN REACTIVATED.
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) { //O(1)
      createWindow();
    }
  });
});

// KEEP THE APP RUNNING ON MACOS AFTER THE LAST WINDOW CLOSES.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { //O(1)
    app.quit();
  }
});
