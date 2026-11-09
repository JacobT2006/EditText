// [Optional, all OS] Fuse.js is reserved for fuzzy search; current note search uses exact text matches.
import Fuse from './node_modules/fuse.js/dist/fuse.mjs';

// [Platform UI, all OS] Add platform classes; macOS uses native chrome while Windows/Linux use custom controls.
document.body.classList.toggle('platform-macos', window.electronAPI.platform === 'darwin');
document.body.classList.toggle('platform-windows', window.electronAPI.platform === 'win32');
document.body.classList.toggle('platform-linux', window.electronAPI.platform === 'linux');
// [Platform UI] Match displayed shortcuts to the native menu accelerator convention.
const shortcutModifier = window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl';
for (const command of ['new', 'open', 'save', 'save-as']) {
  const shortcut = document.querySelector(`[data-command="${command}"] span`);
  if (shortcut) {
    shortcut.textContent = shortcut.textContent.replace('⌘/Ctrl', shortcutModifier);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  // [Core, all OS] Cache the shared editor UI and per-window note/session state.
  const body = document.body;
  const tabsElement = document.getElementById('tabs');
  const editor = document.getElementById('note-content');
  const status = document.getElementById('status');
  const emptyEditors = document.getElementById('empty-editors');
  const breadcrumbName = document.getElementById('breadcrumb-name');
  const timelineLastSaved = document.getElementById('timeline-last-saved');
  const cursorPosition = document.getElementById('cursor-position');
  const explorer = document.querySelector('.explorer');
  const explorerResizer = document.getElementById('explorer-resizer');
  const settingsDialog = document.getElementById('settings-dialog');
  const pluginStoreDialog = document.getElementById('plugin-store-dialog');
  const pluginList = document.getElementById('plugin-list');
  const pluginsStatus = document.getElementById('plugins-status');
  const pluginInstallMode = document.getElementById('plugin-install-mode');
  const pluginTrustWarning = document.getElementById('plugin-trust-warning');
  const pluginModeDescription = document.getElementById('plugin-mode-description');
  const pluginStyles = document.createElement('style');
  pluginStyles.id = 'plugin-styles';
  document.head.append(pluginStyles);
  const pluginStoreGrid = document.getElementById('plugin-store-grid');
  const pluginStoreStatus = document.getElementById('plugin-store-status');
  const pluginStoreSearch = document.getElementById('plugin-store-search');
  const pluginStoreCategories = document.getElementById('plugin-store-categories');
  let pluginCatalog = [];
  let selectedPluginCategory = 'All';
  const autoSaveInput = document.getElementById('auto-save');
  const autoSaveDelayInput = document.getElementById('auto-save-delay');
  const fontSizeInput = document.getElementById('font-size');
  const wordWrapInput = document.getElementById('word-wrap');
  const updateStatus = document.getElementById('update-status');
  const checkUpdatesButton = document.getElementById('check-updates');
  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  const fileMenuTrigger = document.getElementById('file-menu-trigger');
  const fileMenu = document.getElementById('file-menu');
  const menuAutoSaveInput = document.getElementById('menu-auto-save');
  const documents = [];
  let activeId = null;
  let autoSave = true;
  let autoSaveDelay = 800;
  let closeRequested = false;
  let updateReady = false;
  let tabDrag = null;
  let explorerWidth = 240;
  let resizePointerId = null;
  let cursorPositionFrame = null;

  const activeDocument = () => documents.find((document) => document.id === activeId);
  const displayName = (name) => name.replace(/\.txt$/i, '');
  const setStatus = (message) => {
    status.textContent = message;
  };

  // [Core, all OS] Apply auto-save preference changes to the editor and open notes.
  function updateAutoSaveState(enabled) {
    autoSave = enabled;
    autoSaveInput.checked = enabled;
    menuAutoSaveInput.setAttribute('aria-checked', String(enabled));
    window.electronAPI.settings.syncAutoSaveMenuState(enabled);

    if (enabled) { //O(1)
      for (const note of documents) { //O(N)
        if (note.dirty) { //O(1)
          scheduleAutoSave(note);
        }
      }
    } else {
      for (const note of documents) { //O(N)
        clearTimeout(note.timer);
        note.timer = null;
      }
      if (status.textContent === 'Auto-saving…') { //O(1)
        setStatus('Auto-save is off');
      }
    }
  }

  // [Core, all OS] Persist auto-save changes initiated from the Notes menu.
  async function toggleAutoSave() {
    try {
      const settings = await window.electronAPI.settings.get();
      const savedSettings = await window.electronAPI.settings.set({
        ...settings,
        autoSave: !settings.autoSave,
      });
      updateAutoSaveState(savedSettings.autoSave);
      setStatus(savedSettings.autoSave ? 'Auto-save is on' : 'Auto-save is off');
    } catch (error) {
      updateAutoSaveState(autoSave);
      setStatus(`Could not update auto-save: ${error.message}`);
    }
  }

  // [Core, all OS] Load persisted preferences before showing Settings.
  function selectSettingsTab(tab) {
    const pluginsSelected = tab === 'plugins';
    document.getElementById('settings-general-tab').classList.toggle('selected', !pluginsSelected);
    document.getElementById('settings-general-tab').setAttribute('aria-selected', String(!pluginsSelected));
    document.getElementById('settings-plugins-tab').classList.toggle('selected', pluginsSelected);
    document.getElementById('settings-plugins-tab').setAttribute('aria-selected', String(pluginsSelected));
    document.getElementById('settings-general-panel').hidden = pluginsSelected;
    document.getElementById('settings-plugins-panel').hidden = !pluginsSelected;
    settingsDialog.classList.toggle('plugins-settings', pluginsSelected);
  }

  async function openSettings(tab = 'general') {
    try {
      const settings = await window.electronAPI.settings.get();
      autoSaveInput.checked = settings.autoSave;
      menuAutoSaveInput.setAttribute('aria-checked', String(settings.autoSave));
      window.electronAPI.settings.syncAutoSaveMenuState(settings.autoSave);
      autoSaveDelayInput.value = String(settings.autoSaveDelay);
      fontSizeInput.value = String(settings.fontSize);
      wordWrapInput.checked = settings.wordWrap;
      selectSettingsTab(tab);
      settingsDialog.showModal();
      if (tab === 'plugins') {
        await renderPlugins();
        await refreshPluginStyles();
      }
    } catch (error) {
      if (settingsDialog.open) {
        pluginsStatus.textContent = `Could not load plugin settings: ${error.message}`;
      } else {
        setStatus(`Could not load settings: ${error.message}`);
      }
    }
  }

  async function refreshPluginStyles() {
    const stylesheets = await window.electronAPI.plugins.styles();
    pluginStyles.textContent = stylesheets
      .map(({ stylesheet }) => stylesheet)
      .join('\n');
  }

  // [Plugins, all OS] Render installed plugins with separate UI-style and trusted-code controls.
  async function renderPlugins() {
    pluginList.replaceChildren();
    pluginsStatus.textContent = 'Loading plugins…';
    try {
      const plugins = await window.electronAPI.plugins.list();
      if (plugins.length === 0) {
        pluginsStatus.textContent = 'No plugins installed. Install a ZIP or browse community submissions.';
        return;
      }

      pluginsStatus.textContent = '';
      for (const plugin of plugins) {
        const card = document.createElement('article');
        card.className = 'plugin-card';
        const copy = document.createElement('div');
        copy.className = 'plugin-card-copy';
        const name = document.createElement('strong');
        name.textContent = `${plugin.name} ${plugin.version}`;
        const description = document.createElement('span');
        description.textContent = plugin.needsUpdate
          ? `${plugin.description} · Old UI page plugin; reinstall with ui.css`
          : `${plugin.description} · ${plugin.mode === 'trusted' ? 'Trusted code: note and system access' : 'CSS styling/layout only; no note or code access'}`;
        copy.append(name, description);

        const actions = document.createElement('div');
        actions.className = 'plugin-card-actions';
        if (plugin.mode === 'ui') {
          const toggleButton = document.createElement('button');
          toggleButton.type = 'button';
          toggleButton.textContent = plugin.needsUpdate
            ? 'Needs update'
            : plugin.enabled ? 'Disable' : 'Enable';
          toggleButton.disabled = plugin.needsUpdate;
          toggleButton.addEventListener('click', async () => {
            try {
              await window.electronAPI.plugins.setEnabled(plugin.id, !plugin.enabled);
              await refreshPluginStyles();
              await renderPlugins();
              pluginsStatus.textContent = `${plugin.name} styling ${plugin.enabled ? 'disabled' : 'enabled'}.`;
            } catch (error) {
              pluginsStatus.textContent = `Could not update ${plugin.name}: ${error.message}`;
            }
          });
          actions.append(toggleButton);
        } else {
          const runButton = document.createElement('button');
          runButton.type = 'button';
          runButton.textContent = 'Run with note access';
          runButton.addEventListener('click', async () => {
            const note = activeDocument();
            pluginsStatus.textContent = `Running ${plugin.name}…`;
            try {
              const result = await window.electronAPI.plugins.run(
                plugin.id,
                note ? { id: note.id, content: note.content } : null,
              );
              if (typeof result.content === 'string') {
                const currentNote = activeDocument();
                if (!note || !currentNote || currentNote.id !== note.id) {
                  throw new Error('The active note changed while the plugin was running; its result was not applied.');
                }
                editor.value = result.content;
                editor.dispatchEvent(new Event('input', { bubbles: true }));
              }
              pluginsStatus.textContent = `Ran ${plugin.name}.`;
            } catch (error) {
              pluginsStatus.textContent = `Could not run ${plugin.name}: ${error.message}`;
            }
          });
          actions.append(runButton);
        }

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.textContent = 'Remove';
        removeButton.addEventListener('click', async () => {
          if (!window.confirm(`Remove ${plugin.name} and its installed files?`)) {
            return;
          }
          pluginsStatus.textContent = `Removing ${plugin.name}…`;
          try {
            await window.electronAPI.plugins.remove(plugin.id);
            await refreshPluginStyles();
            await renderPlugins();
            pluginsStatus.textContent = `Removed ${plugin.name}.`;
          } catch (error) {
            pluginsStatus.textContent = `Could not remove ${plugin.name}: ${error.message}`;
          }
        });
        actions.append(removeButton);
        card.append(copy, actions);
        pluginList.append(card);
      }
    } catch (error) {
      pluginsStatus.textContent = `Could not load plugins: ${error.message}`;
    }
  }

  // [Plugins, all OS] Explain the permissions granted by the selected install mode.
  function updatePluginModeDescription() {
    pluginTrustWarning.hidden = pluginInstallMode.value !== 'trusted';
    pluginModeDescription.textContent = pluginInstallMode.value === 'trusted'
      ? 'Trusted plugins run arbitrary code only when you choose Run. They can read and change the selected note, access app APIs, files, and network resources.'
      : 'UI plugins use CSS only to change EditText’s appearance and layout. They cannot run code, read note text, access app APIs, or make network requests.';
  }
  pluginInstallMode.addEventListener('change', updatePluginModeDescription);
  updatePluginModeDescription();

  document.getElementById('install-plugin').addEventListener('click', async () => {
    const mode = pluginInstallMode.value;
    pluginsStatus.textContent = 'Choose a plugin ZIP…';
    try {
      const result = await window.electronAPI.plugins.install(mode);
      if (result.canceled) {
        pluginsStatus.textContent = 'Installation canceled.';
        return;
      }
      await refreshPluginStyles();
      await renderPlugins();
      pluginsStatus.textContent = `Installed ${result.plugin.name}.`;
    } catch (error) {
      pluginsStatus.textContent = `Could not install plugin: ${error.message}`;
    }
  });
  document.getElementById('plugin-submissions').addEventListener('click', async () => {
    try {
      await window.electronAPI.plugins.openSubmissions();
    } catch (error) {
      pluginsStatus.textContent = `Could not open GitHub submissions: ${error.message}`;
    }
  });
  document.getElementById('plugin-guide').addEventListener('click', async () => {
    try {
      await window.electronAPI.plugins.openGuide();
    } catch (error) {
      pluginsStatus.textContent = `Could not open plugin guide: ${error.message}`;
    }
  });

  // [Plugins, all OS] Build category chips from the catalog without accepting markup from GitHub.
  function renderPluginStoreCategories() {
    const categories = ['All', ...new Set(pluginCatalog.map((plugin) => plugin.category))];
    if (!categories.includes(selectedPluginCategory)) {
      selectedPluginCategory = 'All';
    }
    pluginStoreCategories.replaceChildren();
    for (const category of categories) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'plugin-store-category';
      button.classList.toggle('selected', category === selectedPluginCategory);
      button.setAttribute('aria-pressed', String(category === selectedPluginCategory));
      button.textContent = category;
      button.addEventListener('click', () => {
        selectedPluginCategory = category;
        renderPluginStore();
      });
      pluginStoreCategories.append(button);
    }
  }

  // [Plugins, all OS] Render searchable extension cards using text-only metadata.
  function renderPluginStore() {
    renderPluginStoreCategories();
    const query = pluginStoreSearch.value.trim().toLocaleLowerCase();
    const visiblePlugins = pluginCatalog.filter((plugin) => (
      (selectedPluginCategory === 'All' || plugin.category === selectedPluginCategory)
      && `${plugin.name} ${plugin.description} ${plugin.author} ${plugin.category}`
        .toLocaleLowerCase()
        .includes(query)
    ));
    pluginStoreGrid.replaceChildren();
    if (visiblePlugins.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'plugin-store-empty';
      const title = document.createElement('strong');
      title.textContent = pluginCatalog.length === 0 ? 'The shelves are ready for extensions' : 'No extensions match';
      const description = document.createElement('p');
      description.textContent = pluginCatalog.length === 0
        ? 'Community extensions will appear here when they are published to the GitHub repository.'
        : 'Try a different search or category.';
      empty.append(title, description);
      pluginStoreGrid.append(empty);
      return;
    }

    for (const plugin of visiblePlugins) {
      const card = document.createElement('article');
      card.className = 'plugin-store-card';
      const cardTop = document.createElement('div');
      cardTop.className = 'plugin-store-card-top';
      const icon = document.createElement('span');
      icon.className = 'plugin-store-icon';
      icon.textContent = plugin.name.trim().slice(0, 1).toLocaleUpperCase();
      const badge = document.createElement('span');
      badge.className = 'plugin-store-badge';
      badge.textContent = plugin.category;
      cardTop.append(icon, badge);

      const name = document.createElement('h3');
      name.textContent = plugin.name;
      const meta = document.createElement('p');
      meta.className = 'plugin-store-meta';
      meta.textContent = `${plugin.version} · by ${plugin.author}`;
      const description = document.createElement('p');
      description.className = 'plugin-store-description';
      description.textContent = plugin.description;
      const permission = document.createElement('p');
      permission.className = 'plugin-store-permission';
      permission.textContent = 'Plugin permissions are checked before installation.';
      const actions = document.createElement('div');
      actions.className = 'plugin-store-card-actions';
      const installButton = document.createElement('button');
      installButton.type = 'button';
      installButton.className = 'plugin-store-install';
      installButton.textContent = plugin.installed ? 'Installed' : 'Install';
      installButton.disabled = plugin.installed;
      installButton.addEventListener('click', async () => {
        installButton.disabled = true;
        installButton.textContent = 'Downloading…';
        pluginStoreStatus.textContent = `Downloading ${plugin.name} from GitHub…`;
        try {
          const result = await window.electronAPI.plugins.installCatalog(plugin.id);
          if (result.canceled) {
            installButton.disabled = false;
            installButton.textContent = 'Install';
            pluginStoreStatus.textContent = 'Installation canceled.';
            return;
          }
          pluginCatalog = await window.electronAPI.plugins.catalog();
          renderPluginStore();
          await refreshPluginStyles();
          pluginStoreStatus.textContent = `Installed ${result.plugin.name}.`;
        } catch (error) {
          installButton.disabled = false;
          installButton.textContent = 'Try again';
          pluginStoreStatus.textContent = `Could not install ${plugin.name}: ${error.message}`;
        }
      });
      const detailsButton = document.createElement('button');
      detailsButton.type = 'button';
      detailsButton.className = 'plugin-store-details';
      detailsButton.textContent = 'Details';
      detailsButton.addEventListener('click', async () => {
        try {
          await window.electronAPI.plugins.openCatalogItem(plugin.id);
        } catch (error) {
          pluginStoreStatus.textContent = `Could not open ${plugin.name}: ${error.message}`;
        }
      });
      actions.append(installButton, detailsButton);
      card.append(cardTop, name, meta, description, permission, actions);
      pluginStoreGrid.append(card);
    }
  }

  // [Plugins, all OS] Load the catalog through the main-process GitHub bridge and expose failures.
  async function loadPluginStore(forceRefresh = false) {
    pluginStoreGrid.replaceChildren();
    pluginStoreStatus.textContent = 'Loading community extensions from GitHub…';
    try {
      pluginCatalog = await window.electronAPI.plugins.catalog(forceRefresh);
      renderPluginStore();
      pluginStoreStatus.textContent = pluginCatalog.length
        ? `${pluginCatalog.length} extension${pluginCatalog.length === 1 ? '' : 's'} from GitHub.`
        : 'No extensions have been published yet.';
    } catch (error) {
      pluginStoreStatus.textContent = `Could not load the GitHub catalog: ${error.message}`;
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.className = 'plugin-store-retry';
      retryButton.textContent = 'Try again';
      retryButton.addEventListener('click', () => loadPluginStore(true));
      pluginStoreGrid.replaceChildren(retryButton);
    }
  }

  document.getElementById('open-plugins').addEventListener('click', async () => {
    pluginStoreDialog.showModal();
    await loadPluginStore();
  });
  document.getElementById('close-plugin-store').addEventListener('click', () => {
    pluginStoreDialog.close();
  });
  document.getElementById('refresh-plugin-store').addEventListener('click', () => loadPluginStore(true));
  pluginStoreSearch.addEventListener('input', renderPluginStore);
  document.getElementById('store-manage-plugins').addEventListener('click', async () => {
    pluginStoreDialog.close();
    await openSettings('plugins');
  });
  document.getElementById('browse-plugin-store').addEventListener('click', () => {
    settingsDialog.close();
    pluginStoreDialog.showModal();
    loadPluginStore();
  });

  // [Optional, packaged builds on all OS] Request updates and display updater status.
  checkUpdatesButton.addEventListener('click', async () => {
    checkUpdatesButton.disabled = true;
    if (updateReady) {
      try {
        await window.electronAPI.updates.install();
      } catch (error) {
        updateStatus.textContent = `Could not install update: ${error.message}`;
        checkUpdatesButton.disabled = false;
      }
      return;
    }
    updateStatus.textContent = 'Checking for updates…';
    try {
      const result = await window.electronAPI.updates.check();
      updateStatus.textContent = result.message;
      checkUpdatesButton.disabled = result.status === 'checking';
    } catch (error) {
      updateStatus.textContent = `Could not check for updates: ${error.message}`;
      checkUpdatesButton.disabled = false;
    }
  });
  window.electronAPI.updates.onStatus(({ status, message }) => {
    updateReady = status === 'downloaded';
    updateStatus.textContent = message;
    checkUpdatesButton.textContent = updateReady ? 'Restart to update' : 'Check for updates';
    checkUpdatesButton.disabled = status === 'checking' || status === 'available';
  });

  // [Core, all OS] Render tabs for open notes and their close controls.
  function renderTabs() {
    tabsElement.replaceChildren();
    emptyEditors.hidden = documents.length > 0;
    for (const note of documents) { //O(N)
      const tab = document.createElement('div');
      tab.className = `tab${note.id === activeId ? ' active' : ''}`;
      tab.dataset.noteId = note.id;
      tab.title = `Drag to reorder ${displayName(note.name)}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(note.id === activeId));

      const select = document.createElement('button');
      select.className = 'tab-select';
      select.type = 'button';
      select.title = `Switch to ${displayName(note.name)}`;

      const icon = document.createElement('img');
      icon.className = 'tab-file-icon';
      const assetBase = window.location.pathname.includes('/test/') ? '../Assets' : 'Assets';
      icon.src = `${assetBase}/Text.svg`;
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = `${displayName(note.name)}${note.dirty ? ' •' : ''}`;
      select.append(icon, label);
      select.addEventListener('click', () => activateDocument(note.id));

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.setAttribute('aria-label', `Close ${displayName(note.name)}`);
      close.title = `Close ${displayName(note.name)}`;
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeDocument(note.id);
      });

      tab.append(select, close);
      tabsElement.append(tab);
    }
  }

  // [Core, all OS] Show the active note's last-save time in the Timeline.
  function renderTimeline(note) {
    if (!note?.lastSavedAt) { //O(1)
      timelineLastSaved.textContent = 'Last saved: Not saved yet';
      timelineLastSaved.removeAttribute('datetime');
    } else {
      const savedDate = new Date(note.lastSavedAt);
      timelineLastSaved.textContent = `Last saved: ${savedDate.toLocaleString()}`;
      timelineLastSaved.dateTime = note.lastSavedAt;
    }
  }

  // [Core, all OS] Activate a note and update its editor, breadcrumb, timeline, and tab.
  function activateDocument(id) {
    const document = documents.find((item) => item.id === id);
    if (!document) { //O(1)
      return;
    }
    activeId = id;
    editor.value = document.content;
    editor.disabled = false;
    breadcrumbName.textContent = displayName(document.name);
    renderTimeline(document);
    if (cursorPositionFrame !== null) { //O(1)
      cancelAnimationFrame(cursorPositionFrame);
      cursorPositionFrame = null;
    }
    updateCursorPosition();
    renderTabs();
    setStatus(document.dirty ? 'Unsaved note changes' : '');
  }

  // [Core, all OS] Keep the cursor line and column visible in the status bar.
  function updateCursorPosition() {
    const beforeCursor = editor.value.slice(0, editor.selectionStart);
    const line = beforeCursor.split('\n').length;
    const column = beforeCursor.length - beforeCursor.lastIndexOf('\n');
    cursorPosition.textContent = `Ln ${line}, Col ${column}`;
  }

  // COALESCE CURSOR UPDATES DURING RAPID EDITING.
  function scheduleCursorPositionUpdate() {
    if (cursorPositionFrame !== null) { //O(1)
      return;
    }
    cursorPositionFrame = requestAnimationFrame(() => {
      cursorPositionFrame = null;
      updateCursorPosition();
    });
  }

  // [Core UI, all OS] Resize the Explorer within the available workspace.
  function setExplorerWidth(width) {
    const minWidth = 190;
    const maxWidth = Math.max(minWidth, Math.min(480, window.innerWidth - 48 - 300));
    explorerWidth = Math.max(minWidth, Math.min(maxWidth, width));
    explorer.style.flexBasis = `${explorerWidth}px`;
    explorerResizer.setAttribute('aria-valuenow', String(Math.round(explorerWidth)));
  }

  // [Core UI, all OS] Support pointer and keyboard Explorer resizing.
  explorerResizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) { //O(1)
      return;
    }
    resizePointerId = event.pointerId;
    explorerResizer.setPointerCapture(event.pointerId);
    body.classList.add('resizing-explorer');
    event.preventDefault();
  });

  explorerResizer.addEventListener('pointermove', (event) => {
    if (resizePointerId !== event.pointerId) { //O(1)
      return;
    }
    const activityBar = document.querySelector('.activity-bar');
    setExplorerWidth(event.clientX - activityBar.getBoundingClientRect().right);
  });

  function stopExplorerResize(event) {
    if (resizePointerId !== event.pointerId) { //O(1)
      return;
    }
    resizePointerId = null;
    body.classList.remove('resizing-explorer');
  }

  explorerResizer.addEventListener('pointerup', stopExplorerResize);
  explorerResizer.addEventListener('pointercancel', stopExplorerResize);
  explorerResizer.addEventListener('lostpointercapture', () => {
    resizePointerId = null;
    body.classList.remove('resizing-explorer');
  });
  explorerResizer.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') { //O(1)
      return;
    }
    event.preventDefault();
    setExplorerWidth(explorerWidth + (event.key === 'ArrowRight' ? 16 : -16));
  });

  // [Core, all OS] Refresh note labels and indicate unsaved changes.
  function refreshDirtyState(document = activeDocument()) {
    if (document) { //O(1)
      const tab = tabsElement.querySelector(
        `[data-note-id="${CSS.escape(document.id)}"]`,
      );
      if (tab) { //O(1)
        const select = tab.querySelector('.tab-select');
        const close = tab.querySelector('.tab-close');
        select.querySelector('.tab-label').textContent =
          `${displayName(document.name)}${document.dirty ? ' •' : ''}`;
        select.title = `Switch to ${displayName(document.name)}`;
        close.setAttribute('aria-label', `Close ${displayName(document.name)}`);
        close.title = `Close ${displayName(document.name)}`;
        tab.title = `Drag to reorder ${displayName(document.name)}`;
      }
    }
    const active = activeDocument();
    if (active) {
      breadcrumbName.textContent = displayName(active.name);
    }
    setStatus(active?.dirty ? 'Unsaved note changes' : '');
  }

  // [Core, all OS] Create a new unsaved note through the main-process note store.
  async function createDocument() {
    try {
      const document = await window.electronAPI.notes.create();
      documents.push({
        ...document,
        dirty: false,
        revision: 0,
        timer: null,
      });
      activateDocument(document.id);
      editor.focus();
    } catch (error) {
      setStatus(`Could not create note: ${error.message}`);
    }
  }

  // [Core, all OS] Open .txt notes and add them to the window's tab list.
  async function openDocuments() {
    try {
      const opened = await window.electronAPI.notes.open();
      for (const document of opened) { //O(N)
        if (!documents.some((existing) => existing.id === document.id)) { //O(1)
          documents.push({
            ...document,
            dirty: false,
            revision: 0,
            timer: null,
          });
        }
      }
      if (opened.length > 0) { //O(1)
        activateDocument(opened[opened.length - 1].id);
        setStatus(`Opened ${opened.length} ${opened.length === 1 ? 'note' : 'notes'}`);
      }
    } catch (error) {
      setStatus(`Could not open note: ${error.message}`);
    }
  }

  // [Core, all OS] Save a note and preserve any edits made during an in-flight save.
  async function saveDocument(document, saveAs = false, automatic = false) {
    if (!document) { //O(1)
      return false;
    }
    if (automatic && !autoSave) { //O(1)
      return false;
    }
    try {
      let shouldSaveAs = saveAs;
      do { //~O(1)
        if (automatic && !autoSave) { //O(1)
          return false;
        }
        const revision = document.revision;
        const result = await window.electronAPI.notes.save(
          document.id,
          document.content,
          shouldSaveAs,
          automatic,
        );
        if (result.canceled) { //O(1)
          return false;
        }
        shouldSaveAs = false;
        document.name = result.name;
        document.hasFile = result.hasFile;
        document.lastSavedAt = result.lastSavedAt;
        if (result.filePath) { //O(1)
          document.filePath = result.filePath;
        }
        document.dirty = revision !== document.revision;
        if (activeId === document.id) { //O(1)
          renderTimeline(document);
        }
      } while (document.dirty);
      clearTimeout(document.timer);
      refreshDirtyState(document);
      setStatus(`Saved note ${document.name}`);
      return true;
    } catch (error) {
      setStatus(`Could not save note ${document.name}: ${error.message}`);
      return false;
    }
  }

  // [Core, all OS] Close a note only after resolving any unsaved changes.
  async function closeDocument(id) {
    const index = documents.findIndex((document) => document.id === id);
    if (index < 0) { //O(1)
      return true;
    }
    const document = documents[index];
    if (document.dirty) { //O(1)
      let choice;
      try {
        choice = await window.electronAPI.notes.confirmClose(document.name);
      } catch (error) {
        setStatus(`Could not close ${document.name}: ${error.message}`);
        return false;
      }
      if (choice === 'cancel') { //O(1)
        return false;
      }
      if (choice === 'save' && !(await saveDocument(document))) { //O(1)
        return false;
      }
    }

    clearTimeout(document.timer);
    try {
      await window.electronAPI.notes.close(id);
    } catch (error) {
      if (document.dirty && autoSave) {
        scheduleAutoSave(document);
      }
      setStatus(`Could not release note ${document.name}: ${error.message}`);
      return false;
    }
    const currentIndex = documents.findIndex((openDocument) => openDocument.id === id);
    if (currentIndex < 0) {
      return true;
    }
    documents.splice(currentIndex, 1);
    if (activeId === id) { //O(1)
      const next = documents[Math.min(currentIndex, documents.length - 1)];
      activeId = null;
      if (next) { //O(1)
        activateDocument(next.id);
      } else {
        editor.value = '';
        editor.disabled = true;
        renderTabs();
        await createDocument();
      }
    } else {
      renderTabs();
    }
    return true;
  }

  // [Core, all OS] Check all open notes before allowing the window to close.
  async function closeWindowAfterCheckingNotes() {
    if (closeRequested) { //O(1)
      return;
    }
    closeRequested = true;
    try {
      const discardedIds = new Set();
      for (const note of documents) { //O(N)
        if (!note.dirty) { //O(1)
          continue;
        }
        const choice = await window.electronAPI.notes.confirmClose(note.name);
        if (choice === 'cancel') { //O(1)
          closeRequested = false;
          await window.electronAPI.window.cancelClose();
          return;
        }
        if (choice === 'save' && !(await saveDocument(note))) { //O(1)
          closeRequested = false;
          await window.electronAPI.window.cancelClose();
          return;
        }
        if (choice === 'discard') { //O(1)
          discardedIds.add(note.id);
        }
      }
      for (const note of documents) { //O(N)
        clearTimeout(note.timer);
        if (discardedIds.has(note.id)) { //O(1)
          note.dirty = false;
        }
      }
      documents.length = 0;
      tabsElement.replaceChildren();
      await window.electronAPI.window.confirmClose();
    } catch (error) {
      closeRequested = false;
      setStatus(`Could not close window: ${error.message}`);
      await window.electronAPI.window.cancelClose();
    }
  }

  // [Core, all OS] Debounce auto-save for notes that already have a file path.
  function scheduleAutoSave(document) {
    clearTimeout(document.timer);
    if (!autoSave || !document.hasFile) { //O(1)
      if (autoSave && !document.hasFile) { //O(1)
        setStatus('Auto-save is on. Save this note once to choose a file.');
      }
      return;
    }
    setStatus('Auto-saving…');
    document.timer = setTimeout(() => {
      document.timer = null;
      if (autoSave) { //O(1)
        saveDocument(document, false, true);
      }
    }, autoSaveDelay);
  }

  // [Core, all OS] Find the next or previous exact-text match in the active note.
  function search(direction = 1) {
    const query = searchInput.value;
    if (!query) { //O(1)
      return;
    }
    const start = direction > 0 ? editor.selectionEnd : editor.selectionStart - 1;
    let index = direction > 0
      ? editor.value.indexOf(query, Math.max(0, start))
      : editor.value.lastIndexOf(query, start);
    if (index < 0) { //O(1)
      index = direction > 0
        ? editor.value.indexOf(query)
        : editor.value.lastIndexOf(query);
    }
    if (index < 0) { //O(1)
      setStatus(`No match for “${query}”`);
      return;
    }
    editor.focus();
    editor.setSelectionRange(index, index + query.length);
    setStatus('');
  }

  // [Platform UI] Wire custom controls; macOS hides these in favor of native traffic lights.
  document.getElementById('close-btn').addEventListener('click', () => {
    window.electronAPI.window.requestClose();
  });
  document.getElementById('minimize-btn').addEventListener('click', () => {
    window.electronAPI.window.minimize();
  });
  document.getElementById('maximize-btn').addEventListener('click', () => {
    window.electronAPI.window.toggleMaximize();
  });
  if (window.electronAPI.platform !== 'darwin') {
    document.querySelector('.title-bar').addEventListener('dblclick', (event) => {
      if (!event.target.closest('button, .window-controls, .file-menu')) {
        window.electronAPI.window.toggleMaximize();
      }
    });
  }
  window.electronAPI.window.onMaximizeState((isMaximized) => {
    const maximizeButton = document.getElementById('maximize-btn');
    const action = isMaximized ? 'shrink' : 'expand';
    const label = isMaximized ? 'Shrink window' : 'Expand window';
    maximizeButton.dataset.maximizeAction = action;
    maximizeButton.setAttribute('aria-label', label);
    maximizeButton.title = label;
  });

  // [Core, all OS] Connect the shared note actions in the activity bar.
  document.getElementById('new-note').addEventListener('click', createDocument);
  document.getElementById('open-settings').addEventListener('click', openSettings);
  document.getElementById('settings-general-tab').addEventListener('click', () => selectSettingsTab('general'));
  document.getElementById('settings-plugins-tab').addEventListener('click', async () => {
    selectSettingsTab('plugins');
    await renderPlugins();
    try {
      await refreshPluginStyles();
    } catch (error) {
      pluginsStatus.textContent = `Could not apply plugin styling: ${error.message}`;
    }
  });
  try {
    await refreshPluginStyles();
  } catch (error) {
    pluginsStatus.textContent = `Could not apply plugin styling: ${error.message}`;
  }
  document.getElementById('quitButton').addEventListener('click', () => {
    window.electronAPI.window.requestClose();
  });
  document.getElementById('open-file').addEventListener('click', openDocuments);

  // [Core UI, all OS] Allow open note tabs to be reordered with pointer dragging.
  tabsElement.addEventListener('pointerdown', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab || event.button !== 0 || event.target.closest('.tab-close')) { //O(1)
      return;
    }
    tabDrag = {
      id: tab.dataset.noteId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      targetId: null,
      insertAfter: false,
    };
  });

  // CLEAR TEMPORARY TAB DRAG HIGHLIGHTS.
  function clearTabDrag() {
    tabsElement.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.remove('dragging', 'drop-before', 'drop-after');
    });
    body.classList.remove('reordering-editors');
  }

  // TRACK THE TAB UNDER THE POINTER WHILE REORDERING.
  window.addEventListener('pointermove', (event) => {
    if (!tabDrag || event.pointerId !== tabDrag.pointerId) { //O(1)
      return;
    }
    if (!tabDrag.started) { //O(1)
      const distance = Math.hypot(event.clientX - tabDrag.startX, event.clientY - tabDrag.startY);
      if (distance < 5) { //O(1)
        return;
      }
      tabDrag.started = true;
      body.classList.add('reordering-editors');
      tabsElement.querySelector(`[data-note-id="${CSS.escape(tabDrag.id)}"]`)
        ?.classList.add('dragging');
    }

    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.tab');
    tabsElement.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.remove('drop-before', 'drop-after');
    });
    if (!target || target.dataset.noteId === tabDrag.id || !tabsElement.contains(target)) { //O(1)
      tabDrag.targetId = null;
      return;
    }

    const bounds = target.getBoundingClientRect();
    tabDrag.targetId = target.dataset.noteId;
    tabDrag.insertAfter = event.clientY >= bounds.top + bounds.height / 2;
    target.classList.add(tabDrag.insertAfter ? 'drop-after' : 'drop-before');
  });

  window.addEventListener('pointerup', (event) => {
    if (!tabDrag || event.pointerId !== tabDrag.pointerId) { //O(1)
      return;
    }
    if (tabDrag.started && tabDrag.targetId) { //O(1)
      const fromIndex = documents.findIndex((note) => note.id === tabDrag.id);
      const [moved] = documents.splice(fromIndex, 1);
      const targetIndex = documents.findIndex((note) => note.id === tabDrag.targetId);
      if (moved && targetIndex >= 0) { //O(1)
        documents.splice(targetIndex + Number(tabDrag.insertAfter), 0, moved);
        renderTabs();
      }
    }
    tabDrag = null;
    clearTabDrag();
  });
  window.addEventListener('pointercancel', () => {
    tabDrag = null;
    clearTabDrag();
  });

  // [Core, all OS] Connect exact-text search and the in-window Notes menu.
  document.getElementById('find-note').addEventListener('click', () => {
    searchBar.hidden = false;
    searchInput.focus();
    searchInput.select();
  });
  document.getElementById('find-next').addEventListener('click', () => search(1));
  document.getElementById('find-previous').addEventListener('click', () => search(-1));
  document.getElementById('close-search').addEventListener('click', () => {
    searchBar.hidden = true;
    editor.focus();
  });




  fileMenuTrigger.addEventListener('click', () => {
    const isOpen = !fileMenu.hidden;
    fileMenu.hidden = isOpen;
    fileMenuTrigger.setAttribute('aria-expanded', String(!isOpen));
  });
  fileMenu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) { //O(1)
      return;
    }
    fileMenu.hidden = true;
    fileMenuTrigger.setAttribute('aria-expanded', 'false');
    window.electronAPI.executeCommand(button.dataset.command).catch((error) => {
      setStatus(`Could not run command: ${error.message}`);
    });
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.file-menu')) { //O(1)
      fileMenu.hidden = true;
      fileMenuTrigger.setAttribute('aria-expanded', 'false');
    }
  });

  // [Core, all OS] Track edits and schedule auto-save when enabled.
  editor.addEventListener('input', () => {
    const document = activeDocument();
    if (!document || document.content === editor.value) { //O(1)
      return;
    }
    document.content = editor.value;
    document.revision += 1;
    document.dirty = true;
    refreshDirtyState();
    scheduleAutoSave(document);
    scheduleCursorPositionUpdate();
  });
  editor.addEventListener('click', scheduleCursorPositionUpdate);
  editor.addEventListener('keyup', scheduleCursorPositionUpdate);

  // [Core, all OS] Validate and persist user changes to editor settings.
  document.getElementById('save-settings').addEventListener('click', async (event) => {
    event.preventDefault();
    if (!fontSizeInput.reportValidity()) { //O(1)
      return;
    }
    try {
      const settings = await window.electronAPI.settings.set({
        autoSave: autoSaveInput.checked,
        autoSaveDelay: Number(autoSaveDelayInput.value),
        fontSize: Number(fontSizeInput.value),
        wordWrap: wordWrapInput.checked,
      });
      autoSaveDelay = settings.autoSaveDelay;
      updateAutoSaveState(settings.autoSave);
      editor.style.fontSize = `${settings.fontSize}px`;
      editor.wrap = settings.wordWrap ? 'soft' : 'off';
      settingsDialog.close();
      if (!autoSave) { //O(1)
        setStatus('Auto-save is off');
      }
    } catch (error) {
      setStatus(`Could not save settings: ${error.message}`);
    }
  });

  // [Core, all OS] Route native-menu and in-window menu commands to shared note actions.
  function handleCommand(command) {
    switch (command) { //O(1)
      case 'new':
        createDocument();
        break;
      case 'open':
        openDocuments();
        break;
      case 'save':
        saveDocument(activeDocument());
        break;
      case 'save-as':
        saveDocument(activeDocument(), true);
        break;
      case 'toggle-auto-save':
        toggleAutoSave();
        break;
      case 'settings':
        openSettings();
        break;
      case 'close-window':
        window.electronAPI.window.requestClose();
        break;
    }
  }

  // [Core, all OS] Register menu commands and the unsaved-note close guard.
  window.electronAPI.onCommand(handleCommand);
  window.electronAPI.window.onCloseRequested(closeWindowAfterCheckingNotes);

  // [Core, all OS] Handle search keys and dim the UI while its window is inactive.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !searchBar.hidden) { //O(1)
      searchBar.hidden = true;
    }
    if (event.key === 'Enter' && searchBar.contains(document.activeElement)) { //O(1)
      event.preventDefault();
      search(event.shiftKey ? -1 : 1);
    }
  });
  window.addEventListener('blur', () => body.classList.add('inactive'));
  window.addEventListener('focus', () => body.classList.remove('inactive'));

  // [Core, all OS] Apply saved preferences, then open the initial unsaved note.
  try {
    const settings = await window.electronAPI.settings.get();
    updateAutoSaveState(settings.autoSave);
    autoSaveDelay = settings.autoSaveDelay;
    editor.style.fontSize = `${settings.fontSize}px`;
    editor.wrap = settings.wordWrap ? 'soft' : 'off';
  } catch (error) {
    setStatus(`Could not load settings: ${error.message}`);
  }
  await createDocument();
});
