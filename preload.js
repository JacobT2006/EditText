const { contextBridge, ipcRenderer } = require('electron');

// EXPOSE ONLY THE APP ACTIONS NEEDED BY THE RENDERER.
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // FORWARD WINDOW ACTIONS AND STATE EVENTS.
  window: {
    minimize: () => ipcRenderer.invoke('window-control', 'minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window-control', 'toggle-maximize'),
    confirmClose: () => ipcRenderer.invoke('window-control', 'confirm-close'),
    cancelClose: () => ipcRenderer.invoke('window-control', 'cancel-close'),
    requestClose: () => ipcRenderer.invoke('window-control', 'request-close'),
    onCloseRequested: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('window-close-requested', listener);
      return () => ipcRenderer.removeListener('window-close-requested', listener);
    },
    onMaximizeState: (callback) => {
      const listener = (_event, isMaximized) => callback(isMaximized);
      ipcRenderer.on('window-maximize-state', listener);
      return () => ipcRenderer.removeListener('window-maximize-state', listener);
    },
  },
  // CREATE, OPEN, SAVE, AND CLOSE TEXT NOTES.
  notes: {
    create: () => ipcRenderer.invoke('note:new'),
    open: () => ipcRenderer.invoke('note:open'),
    save: (id, content, saveAs = false, automatic = false) =>
      ipcRenderer.invoke('note:save', { id, content, saveAs, automatic }),
    confirmClose: (name) => ipcRenderer.invoke('note:confirm-close', name),
  },
  // LOAD PREFERENCES AND SYNC AUTO-SAVE MENU STATE.
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings) => ipcRenderer.invoke('settings:set', settings),
    syncAutoSaveMenuState: (enabled) => ipcRenderer.send('settings:auto-save-menu-state', enabled),
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    onStatus: (callback) => {
      const listener = (_event, updateStatus) => callback(updateStatus);
      ipcRenderer.on('updates:status', listener);
      return () => ipcRenderer.removeListener('updates:status', listener);
    },
  },
  // SEND APP MENU COMMANDS TO THE RENDERER.
  executeCommand: (command) => ipcRenderer.invoke('app:command', command),
  onCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('app-command', listener);
    return () => ipcRenderer.removeListener('app-command', listener);
  },
});
