document.body.classList.toggle('platform-macos', window.electronAPI.platform === 'darwin');
document.body.classList.toggle('platform-windows', window.electronAPI.platform === 'win32');
document.body.classList.toggle('platform-linux', window.electronAPI.platform === 'linux');
const shortcutModifier = window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl';
for (const command of ['new', 'open', 'save', 'save-as']) {
  const shortcut = document.querySelector(`[data-command="${command}"] span`);
  if (shortcut) {
    shortcut.textContent = shortcut.textContent.replace('⌘/Ctrl', shortcutModifier);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  // CACHE NOTE UI ELEMENTS AND SESSION STATE.
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

  // APPLY AUTO-SAVE CHANGES TO SETTINGS AND OPEN NOTES.
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

  // TOGGLE AUTO-SAVE FROM THE NOTES MENU.
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

  // LOAD CURRENT PREFERENCES BEFORE SHOWING SETTINGS.
  async function openSettings() {
    try {
      const settings = await window.electronAPI.settings.get();
      autoSaveInput.checked = settings.autoSave;
      menuAutoSaveInput.setAttribute('aria-checked', String(settings.autoSave));
      window.electronAPI.settings.syncAutoSaveMenuState(settings.autoSave);
      autoSaveDelayInput.value = String(settings.autoSaveDelay);
      fontSizeInput.value = String(settings.fontSize);
      wordWrapInput.checked = settings.wordWrap;
      settingsDialog.showModal();
    } catch (error) {
      setStatus(`Could not load settings: ${error.message}`);
    }
  }

  // REQUEST A RELEASE CHECK AND DISPLAY UPDATER EVENTS.
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

  // REBUILD THE OPEN-NOTE LIST AND ITS CLOSE CONTROLS.
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
      icon.src = 'Assets/Text.svg';
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

  // SHOW WHEN THE ACTIVE NOTE WAS LAST SAVED.
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

  // DISPLAY A NOTE AND UPDATE ITS RELATED PANELS.
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

  // KEEP THE CURSOR POSITION VISIBLE IN THE STATUS BAR.
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

  // RESIZE THE EXPLORER WITHIN THE AVAILABLE WORKSPACE.
  function setExplorerWidth(width) {
    const minWidth = 190;
    const maxWidth = Math.max(minWidth, Math.min(480, window.innerWidth - 48 - 300));
    explorerWidth = Math.max(minWidth, Math.min(maxWidth, width));
    explorer.style.flexBasis = `${explorerWidth}px`;
    explorerResizer.setAttribute('aria-valuenow', String(Math.round(explorerWidth)));
  }

  // SUPPORT POINTER AND KEYBOARD EXPLORER RESIZING.
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

  // REFRESH OPEN-NOTE LABELS AND UNSAVED STATUS.
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

  // CREATE A NEW UNSAVED NOTE TAB.
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

  // OPEN TEXT NOTES AND ADD THEM TO THE TAB LIST.
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

  // SAVE A NOTE AND PRESERVE EDITS MADE WHILE SAVING.
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

  // CLOSE A NOTE AFTER RESOLVING UNSAVED CHANGES.
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
    documents.splice(index, 1);
    if (activeId === id) { //O(1)
      const next = documents[Math.min(index, documents.length - 1)];
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

  // CHECK EVERY OPEN NOTE BEFORE CLOSING THE WINDOW.
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

  // SAVE CHANGES AFTER THE USER'S AUTO-SAVE DELAY.
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

  // FIND THE NEXT OR PREVIOUS MATCH IN THE ACTIVE NOTE.
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

  // CONNECT THE CUSTOM WINDOW CONTROLS.
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

  // CONNECT NOTE CREATION, OPENING, AND CLOSE ACTIONS.
  document.getElementById('new-note').addEventListener('click', createDocument);
  document.getElementById('open-settings').addEventListener('click', openSettings);
  document.getElementById('quitButton').addEventListener('click', () => {
    window.electronAPI.window.requestClose();
  });
  document.getElementById('open-file').addEventListener('click', openDocuments);

  // REORDER OPEN NOTE TABS WITH POINTER DRAGGING.
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

  // CONNECT NOTE SEARCH AND NOTES MENU COMMANDS.                            Implement fuzy search using fuse.js
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

  // TRACK NOTE CHANGES AND SCHEDULE AUTO-SAVE.
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

  // VALIDATE AND APPLY UPDATED NOTE SETTINGS.
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

  // ROUTE NATIVE MENU COMMANDS TO NOTE ACTIONS.
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

  // REGISTER MENU AND WINDOW-CLOSE HANDLERS.
  window.electronAPI.onCommand(handleCommand);
  window.electronAPI.window.onCloseRequested(closeWindowAfterCheckingNotes);

  // HANDLE SEARCH SHORTCUTS AND WINDOW FOCUS.
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

  // LOAD SAVED PREFERENCES BEFORE CREATING THE FIRST NOTE.
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
