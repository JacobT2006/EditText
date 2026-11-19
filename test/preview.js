window.electronAPI = {
  platform: 'win32',
  settings: {
    get: async () => ({ autoSave: true, autoSaveDelay: 800, fontSize: 18, wordWrap: true }),
    set: async (next) => ({ autoSave: true, autoSaveDelay: 800, fontSize: 18, wordWrap: true, ...next }),
    syncAutoSaveMenuState: () => {}
  },
  plugins: {
    styles: async () => [],
    list: async () => [],
    setEnabled: async () => {},
    run: async () => ({ content: '' }),
    remove: async () => {},
    install: async () => ({ canceled: true }),
    catalog: async () => [],
    installCatalog: async () => ({ canceled: true }),
    openGuide: async () => {},
    openSubmissions: async () => {},
    openCatalogItem: async () => {}
  },
  updates: {
    check: async () => ({ status: 'up-to-date', message: 'No updates available.' }),
    install: async () => {},
    onStatus: (handler) => handler({ status: 'up-to-date', message: 'No updates available.' })
  },
  notes: {
    create: async () => ({
      id: 'demo-note',
      name: 'Project Notes.txt',
      content: 'Windows preview\n\n- Start writing notes\n- Search inside the file\n- Save changes automatically',
      hasFile: false,
      lastSavedAt: new Date().toISOString(),
    }),
    open: async () => [],
    save: async (_id, content) => ({
      name: 'Project Notes.txt',
      hasFile: false,
      lastSavedAt: new Date().toISOString(),
      filePath: null,
      canceled: false,
      content,
    }),
    confirmClose: async () => 'discard',
    close: async () => {}
  },
  window: {
    requestClose: () => {},
    minimize: () => {},
    toggleMaximize: () => {},
    onMaximizeState: (handler) => handler(false),
    onCloseRequested: () => {},
    cancelClose: async () => {},
    confirmClose: async () => {}
  },
  executeCommand: async () => {},
  onCommand: () => {}
};
