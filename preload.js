const { contextBridge, ipcRenderer } = require('electron');

// [Core, all OS] Expose a narrow, context-isolated API instead of Node.js to the renderer.
contextBridge.exposeInMainWorld('electronAPI', {
  // [Platform UI] Renderer uses this only for platform-specific chrome and shortcut labels.
  platform: process.platform,
  // [Core, all OS] Forward window controls and close/maximize state events.
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
  // [Core, all OS] Route note lifecycle operations to the main process.
  notes: {
    create: () => ipcRenderer.invoke('note:new'),
    open: () => ipcRenderer.invoke('note:open'),
    close: (id) => ipcRenderer.invoke('note:close', id),
    save: (id, content, saveAs = false, automatic = false) =>
      ipcRenderer.invoke('note:save', { id, content, saveAs, automatic }),
    confirmClose: (name) => ipcRenderer.invoke('note:confirm-close', name),
  },
  // [Core, all OS] Read and persist preferences and synchronize the native menu checkbox.
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings) => ipcRenderer.invoke('settings:set', settings),
    syncAutoSaveMenuState: (enabled) => ipcRenderer.send('settings:auto-save-menu-state', enabled),
  },
  // [Optional, packaged builds on all OS] Check and install app updates.
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    onStatus: (callback) => {
      const listener = (_event, updateStatus) => callback(updateStatus);
      ipcRenderer.on('updates:status', listener);
      return () => ipcRenderer.removeListener('updates:status', listener);
    },
  },
  // [Plugins, all OS] Keep UI styling and trusted note-processing behind separate IPC actions.
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    styles: () => ipcRenderer.invoke('plugins:styles'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('plugins:set-enabled', id, enabled),
    setTheme: (id, themeId) => ipcRenderer.invoke('plugins:set-theme', id, themeId),
    catalog: (forceRefresh) => ipcRenderer.invoke('plugins:catalog', forceRefresh),
    install: (mode) => ipcRenderer.invoke('plugins:install', mode),
    installCatalog: (id) => ipcRenderer.invoke('plugins:install-catalog', id),
    run: (id, note, appContext) => ipcRenderer.invoke('plugins:run', id, note, appContext),
    remove: (id) => ipcRenderer.invoke('plugins:remove', id),
    openCatalogItem: (id) => ipcRenderer.invoke('plugins:open-catalog-item', id),
    openSubmissions: () => ipcRenderer.invoke('plugins:open-submissions'),
    openGuide: () => ipcRenderer.invoke('plugins:open-guide'),
  },
  // [Core, all OS] Safely relay supported menu commands to the renderer.
  executeCommand: (command) => ipcRenderer.invoke('app:command', command),
  onCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('app-command', listener);
    return () => ipcRenderer.removeListener('app-command', listener);
  },
});
