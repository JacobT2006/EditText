const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const isDev = !app.isPackaged;
const documentsByWindow = new Map();
const closeApproved = new WeakSet();
const closePending = new WeakSet();
const defaultSettings = {
  autoSave: false,
  autoSaveDelay: 800,
  fontSize: 13,
  wordWrap: true,
};
const minFontSize = 6;
const maxFontSize = 72;
const appCommands = new Set([
  'new',
  'open',
  'save',
  'save-as',
  'toggle-auto-save',
  'settings',
  'close-window',
]);

function getWindowDocuments(webContents) {
  let documents = documentsByWindow.get(webContents.id);
  if (!documents) {
    documents = new Map();
    documentsByWindow.set(webContents.id, documents);
    webContents.once('destroyed', () => documentsByWindow.delete(webContents.id));
  }
  return documents;
}

function sendCommand(command) {
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('app-command', command);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 8, y: 10 },
        }
      : { frame: false }),
    title: 'Unix Notes',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.platform !== 'darwin') {
    win.setMenuBarVisibility(false);
  }
  const sendMaximizeState = () => {
    if (!win.isDestroyed()) {
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
    if (closeApproved.has(win)) {
      return;
    }

    event.preventDefault();
    if (!closePending.has(win)) {
      closePending.add(win);
      win.webContents.send('window-close-requested');
    }
  });

  return win;
}

const contextMenu = Menu.buildFromTemplate([
  { role: 'cut' },
  { role: 'copy' },
  { role: 'paste' },
  { type: 'separator' },
  {
    label: 'Toggle Developer Tools',
    enabled: isDev,
    accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
    click(_item, focusedWindow) {
      focusedWindow?.webContents.toggleDevTools();
    },
  },
]);

const autoSaveMenuItem = {
  label: 'Auto Save',
  type: 'checkbox',
  checked: false,
  click: () => sendCommand('toggle-auto-save'),
};

const fileMenu = {
  label: 'File',
  submenu: [
    { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new') },
    { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open') },
    { type: 'separator' },
    autoSaveMenuItem,
    { type: 'separator' },
    { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
    {
      label: 'Save As…',
      accelerator: 'CmdOrCtrl+Shift+S',
      click: () => sendCommand('save-as'),
    },
    { type: 'separator' },
    { label: 'Settings…', click: () => sendCommand('settings') },
    { type: 'separator' },
    { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('close-window') },
  ],
};

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
            { role: 'quit' },
          ],
        },
      ]
    : []),
  fileMenu,
  { role: 'editMenu' },
  { role: 'viewMenu' },
  { role: 'windowMenu' },
];

ipcMain.handle('window-control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return;
  }

  switch (action) {
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

ipcMain.handle('app:command', (event, command) => {
  if (!appCommands.has(command)) {
    throw new Error(`Unsupported application command: ${command}`);
  }
  event.sender.send('app-command', command);
});

ipcMain.handle('note:new', (event) => {
  const document = { id: randomUUID(), filePath: null, name: 'Untitled', content: '' };
  getWindowDocuments(event.sender).set(document.id, document);
  return { id: document.id, name: document.name, content: document.content, hasFile: false };
});

ipcMain.handle('note:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return [];
  }

  const result = await dialog.showOpenDialog(win, {
    title: 'Open text files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Text files', extensions: ['txt'] }],
  });
  if (result.canceled) {
    return [];
  }

  const documents = getWindowDocuments(event.sender);
  const opened = [];
  for (const filePath of result.filePaths) {
    const existing = [...documents.values()].find((document) => document.filePath === filePath);
    if (existing) {
      opened.push({
        id: existing.id,
        name: existing.name,
        filePath: existing.filePath,
        content: existing.content,
        hasFile: true,
      });
      continue;
    }
    const content = await fs.readFile(filePath, 'utf8');
    const document = {
      id: randomUUID(),
      filePath,
      name: path.basename(filePath),
      content,
    };
    documents.set(document.id, document);
    opened.push({
      id: document.id,
      name: document.name,
      filePath: document.filePath,
      content: document.content,
      hasFile: true,
    });
  }
  return opened;
});

ipcMain.handle('note:save', async (event, { id, content, saveAs = false }) => {
  if (typeof id !== 'string' || typeof content !== 'string') {
    throw new TypeError('A note id and text content are required to save a note.');
  }

  const documents = getWindowDocuments(event.sender);
  const document = documents.get(id);
  if (!document) {
    throw new Error('This note is no longer open.');
  }

  let filePath = document.filePath;
  if (saveAs || !filePath) {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, {
      title: 'Save text file',
      defaultPath: document.name === 'Untitled' ? 'Untitled.txt' : document.name,
      buttonLabel: 'Save',
      filters: [{ name: 'Text files', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }
    filePath = path.extname(result.filePath)
      ? result.filePath
      : `${result.filePath}.txt`;
  }

  if ([...documents.values()].some((openDocument) =>
    openDocument.id !== id && openDocument.filePath === filePath)) {
    throw new Error('That file is already open in another tab.');
  }

  await fs.writeFile(filePath, content, 'utf8');
  document.filePath = filePath;
  document.name = path.basename(filePath);
  document.content = content;
  return {
    canceled: false,
    name: document.name,
    filePath: document.filePath,
    hasFile: true,
  };
});

ipcMain.handle('note:confirm-close', async (event, name) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return 'cancel';
  }
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save', "Don’t Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: `Save changes to ${name}?`,
    detail: 'Your changes will be lost if you close this note without saving.',
  });
  return ['save', 'discard', 'cancel'][result.response];
});

ipcMain.handle('settings:get', async () => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    return {
      autoSave: settings.autoSave === true,
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
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ...defaultSettings };
    }
    throw error;
  }
});

ipcMain.handle('settings:set', async (_event, settings) => {
  if (
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
  return savedSettings;
});

ipcMain.on('settings:auto-save-menu-state', (_event, enabled) => {
  if (typeof enabled === 'boolean') {
    autoSaveMenuItem.checked = enabled;
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
