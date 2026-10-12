document.body.classList.toggle('platform-macos', window.electronAPI.platform === 'darwin');

window.addEventListener('DOMContentLoaded', async () => {
  const body = document.body;
  const tabsElement = document.getElementById('tabs');
  const editor = document.getElementById('note-content');
  const status = document.getElementById('status');
  const emptyEditors = document.getElementById('empty-editors');
  const breadcrumbName = document.getElementById('breadcrumb-name');
  const timelineName = document.getElementById('timeline-name');
  const timelineAdditions = document.getElementById('timeline-additions');
  const timelineEmpty = document.getElementById('timeline-empty');
  const cursorPosition = document.getElementById('cursor-position');
  const explorer = document.querySelector('.explorer');
  const explorerResizer = document.getElementById('explorer-resizer');
  const settingsDialog = document.getElementById('settings-dialog');
  const autoSaveInput = document.getElementById('auto-save');
  const autoSaveDelayInput = document.getElementById('auto-save-delay');
  const fontSizeInput = document.getElementById('font-size');
  const wordWrapInput = document.getElementById('word-wrap');
  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  const fileMenuTrigger = document.getElementById('file-menu-trigger');
  const fileMenu = document.getElementById('file-menu');
  const menuAutoSaveInput = document.getElementById('menu-auto-save');
  const documents = [];
  let activeId = null;
  let autoSave = false;
  let autoSaveDelay = 800;
  let closeRequested = false;
  let tabDrag = null;
  let explorerWidth = 240;
  let resizePointerId = null;

  const activeDocument = () => documents.find((document) => document.id === activeId);
  const setStatus = (message) => {
    status.textContent = message;
  };

  function updateAutoSaveState(enabled) {
    autoSave = enabled;
    autoSaveInput.checked = enabled;
    menuAutoSaveInput.setAttribute('aria-checked', String(enabled));
    window.electronAPI.settings.syncAutoSaveMenuState(enabled);

    if (enabled) {
      for (const note of documents) {
        if (note.dirty) {
          scheduleAutoSave(note);
        }
      }
    } else {
      for (const note of documents) {
        clearTimeout(note.timer);
      }
    }
  }

  async function toggleAutoSave() {
    try {
      const settings = await window.electronAPI.settings.get();
      const savedSettings = await window.electronAPI.settings.set({
        ...settings,
        autoSave: !autoSave,
      });
      updateAutoSaveState(savedSettings.autoSave);
      setStatus(savedSettings.autoSave ? 'Auto-save is on' : 'Auto-save is off');
    } catch (error) {
      updateAutoSaveState(autoSave);
      setStatus(`Could not update auto-save: ${error.message}`);
    }
  }

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

  function renderTabs() {
    tabsElement.replaceChildren();
    emptyEditors.hidden = documents.length > 0;
    for (const note of documents) {
      const tab = document.createElement('div');
      tab.className = `tab${note.id === activeId ? ' active' : ''}`;
      tab.dataset.noteId = note.id;
      tab.title = `Drag to reorder ${note.name}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(note.id === activeId));

      const select = document.createElement('button');
      select.className = 'tab-select';
      select.type = 'button';
      select.textContent = `${note.name}${note.dirty ? ' •' : ''}`;
      select.title = `Switch to ${note.name}`;
      select.addEventListener('click', () => activateDocument(note.id));

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.setAttribute('aria-label', `Close ${note.name}`);
      close.title = `Close ${note.name}`;
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeDocument(note.id);
      });

      tab.append(select, close);
      tabsElement.append(tab);
    }
  }

  function renderTimeline(note) {
    timelineAdditions.replaceChildren();
    timelineName.textContent = note ? note.name : 'Recent additions';
    timelineEmpty.hidden = Boolean(note?.additions.length);
    if (!note) {
      return;
    }

    for (const addition of note.additions) {
      const item = document.createElement('li');
      const time = document.createElement('time');
      time.dateTime = addition.timestamp;
      time.title = 'Time this text was added';
      time.textContent = new Date(addition.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      const text = document.createElement('span');
      text.title = 'Text added in this edit';
      text.textContent = addition.text.length > 120
        ? `${addition.text.slice(0, 120)}…`
        : addition.text;
      item.append(time, text);
      timelineAdditions.append(item);
    }
  }

  function findInsertedText(previous, current) {
    let prefixLength = 0;
    while (
      prefixLength < previous.length
      && prefixLength < current.length
      && previous[prefixLength] === current[prefixLength]
    ) {
      prefixLength += 1;
    }

    let suffixLength = 0;
    while (
      suffixLength < previous.length - prefixLength
      && suffixLength < current.length - prefixLength
      && previous[previous.length - suffixLength - 1]
        === current[current.length - suffixLength - 1]
    ) {
      suffixLength += 1;
    }
    return current.slice(prefixLength, current.length - suffixLength);
  }

  function activateDocument(id) {
    const document = documents.find((item) => item.id === id);
    if (!document) {
      return;
    }
    activeId = id;
    editor.value = document.content;
    editor.disabled = false;
    breadcrumbName.textContent = document.name;
    renderTimeline(document);
    updateCursorPosition();
    renderTabs();
    setStatus(document.dirty ? 'Unsaved changes' : '');
  }

  function updateCursorPosition() {
    const beforeCursor = editor.value.slice(0, editor.selectionStart);
    const line = beforeCursor.split('\n').length;
    const column = beforeCursor.length - beforeCursor.lastIndexOf('\n');
    cursorPosition.textContent = `Ln ${line}, Col ${column}`;
  }

  function setExplorerWidth(width) {
    const minWidth = 190;
    const maxWidth = Math.max(minWidth, Math.min(480, window.innerWidth - 48 - 300));
    explorerWidth = Math.max(minWidth, Math.min(maxWidth, width));
    explorer.style.flexBasis = `${explorerWidth}px`;
    explorerResizer.setAttribute('aria-valuenow', String(Math.round(explorerWidth)));
  }

  explorerResizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    resizePointerId = event.pointerId;
    explorerResizer.setPointerCapture(event.pointerId);
    body.classList.add('resizing-explorer');
    event.preventDefault();
  });

  explorerResizer.addEventListener('pointermove', (event) => {
    if (resizePointerId !== event.pointerId) {
      return;
    }
    const activityBar = document.querySelector('.activity-bar');
    setExplorerWidth(event.clientX - activityBar.getBoundingClientRect().right);
  });

  function stopExplorerResize(event) {
    if (resizePointerId !== event.pointerId) {
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
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    setExplorerWidth(explorerWidth + (event.key === 'ArrowRight' ? 16 : -16));
  });

  function refreshDirtyState() {
    renderTabs();
    const document = activeDocument();
    setStatus(document?.dirty ? 'Unsaved changes' : '');
  }

  async function createDocument() {
    try {
      const document = await window.electronAPI.notes.create();
      documents.push({ ...document, dirty: false, revision: 0, timer: null, additions: [] });
      activateDocument(document.id);
      editor.focus();
    } catch (error) {
      setStatus(`Could not create note: ${error.message}`);
    }
  }

  async function openDocuments() {
    try {
      const opened = await window.electronAPI.notes.open();
      for (const document of opened) {
        if (!documents.some((existing) => existing.id === document.id)) {
          documents.push({ ...document, dirty: false, revision: 0, timer: null, additions: [] });
        }
      }
      if (opened.length > 0) {
        activateDocument(opened[opened.length - 1].id);
        setStatus(`Opened ${opened.length} ${opened.length === 1 ? 'file' : 'files'}`);
      }
    } catch (error) {
      setStatus(`Could not open file: ${error.message}`);
    }
  }

  async function saveDocument(document, saveAs = false) {
    if (!document) {
      return false;
    }
    try {
      let shouldSaveAs = saveAs;
      do {
        const revision = document.revision;
        const result = await window.electronAPI.notes.save(
          document.id,
          document.content,
          shouldSaveAs,
        );
        if (result.canceled) {
          return false;
        }
        shouldSaveAs = false;
        document.name = result.name;
        document.hasFile = result.hasFile;
        if (result.filePath) {
          document.filePath = result.filePath;
        }
        document.dirty = revision !== document.revision;
      } while (document.dirty);
      clearTimeout(document.timer);
      refreshDirtyState();
      setStatus(`Saved ${document.name}`);
      return true;
    } catch (error) {
      setStatus(`Could not save ${document.name}: ${error.message}`);
      return false;
    }
  }

  async function closeDocument(id) {
    const index = documents.findIndex((document) => document.id === id);
    if (index < 0) {
      return true;
    }
    const document = documents[index];
    if (document.dirty) {
      let choice;
      try {
        choice = await window.electronAPI.notes.confirmClose(document.name);
      } catch (error) {
        setStatus(`Could not close ${document.name}: ${error.message}`);
        return false;
      }
      if (choice === 'cancel') {
        return false;
      }
      if (choice === 'save' && !(await saveDocument(document))) {
        return false;
      }
    }

    clearTimeout(document.timer);
    documents.splice(index, 1);
    if (activeId === id) {
      const next = documents[Math.min(index, documents.length - 1)];
      activeId = null;
      if (next) {
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

  async function closeWindowAfterCheckingNotes() {
    if (closeRequested) {
      return;
    }
    closeRequested = true;
    try {
      const discardedIds = new Set();
      for (const note of documents) {
        if (!note.dirty) {
          continue;
        }
        const choice = await window.electronAPI.notes.confirmClose(note.name);
        if (choice === 'cancel') {
          closeRequested = false;
          await window.electronAPI.window.cancelClose();
          return;
        }
        if (choice === 'save' && !(await saveDocument(note))) {
          closeRequested = false;
          await window.electronAPI.window.cancelClose();
          return;
        }
        if (choice === 'discard') {
          discardedIds.add(note.id);
        }
      }
      for (const note of documents) {
        clearTimeout(note.timer);
        if (discardedIds.has(note.id)) {
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

  function scheduleAutoSave(document) {
    clearTimeout(document.timer);
    if (!autoSave || !document.hasFile) {
      if (autoSave && !document.hasFile) {
        setStatus('Auto-save is on. Use Save or Save As for this new note.');
      }
      return;
    }
    setStatus('Auto-saving…');
    document.timer = setTimeout(() => {
      saveDocument(document);
    }, autoSaveDelay);
  }

  function search(direction = 1) {
    const query = searchInput.value;
    if (!query) {
      return;
    }
    const start = direction > 0 ? editor.selectionEnd : editor.selectionStart - 1;
    let index = direction > 0
      ? editor.value.indexOf(query, Math.max(0, start))
      : editor.value.lastIndexOf(query, start);
    if (index < 0) {
      index = direction > 0
        ? editor.value.indexOf(query)
        : editor.value.lastIndexOf(query);
    }
    if (index < 0) {
      setStatus(`No match for “${query}”`);
      return;
    }
    editor.focus();
    editor.setSelectionRange(index, index + query.length);
    setStatus('');
  }

  document.getElementById('close-btn').addEventListener('click', () => {
    window.electronAPI.window.requestClose();
  });
  document.getElementById('minimize-btn').addEventListener('click', () => {
    window.electronAPI.window.minimize();
  });
  document.getElementById('maximize-btn').addEventListener('click', () => {
    window.electronAPI.window.toggleMaximize();
  });
  window.electronAPI.window.onMaximizeState((isMaximized) => {
    const maximizeButton = document.getElementById('maximize-btn');
    const action = isMaximized ? 'shrink' : 'expand';
    const label = isMaximized ? 'Shrink window' : 'Expand window';
    maximizeButton.dataset.maximizeAction = action;
    maximizeButton.setAttribute('aria-label', label);
    maximizeButton.title = label;
  });
  document.getElementById('new-note').addEventListener('click', createDocument);
  document.getElementById('quitButton').addEventListener('click', () => {
    window.electronAPI.window.requestClose();
  });
  document.getElementById('new-tab').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    createDocument();
  });
  document.getElementById('open-file').addEventListener('click', openDocuments);
  tabsElement.addEventListener('pointerdown', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab || event.button !== 0 || event.target.closest('.tab-close')) {
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

  function clearTabDrag() {
    tabsElement.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.remove('dragging', 'drop-before', 'drop-after');
    });
    body.classList.remove('reordering-editors');
  }

  window.addEventListener('pointermove', (event) => {
    if (!tabDrag || event.pointerId !== tabDrag.pointerId) {
      return;
    }
    if (!tabDrag.started) {
      const distance = Math.hypot(event.clientX - tabDrag.startX, event.clientY - tabDrag.startY);
      if (distance < 5) {
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
    if (!target || target.dataset.noteId === tabDrag.id || !tabsElement.contains(target)) {
      tabDrag.targetId = null;
      return;
    }

    const bounds = target.getBoundingClientRect();
    tabDrag.targetId = target.dataset.noteId;
    tabDrag.insertAfter = event.clientY >= bounds.top + bounds.height / 2;
    target.classList.add(tabDrag.insertAfter ? 'drop-after' : 'drop-before');
  });

  window.addEventListener('pointerup', (event) => {
    if (!tabDrag || event.pointerId !== tabDrag.pointerId) {
      return;
    }
    if (tabDrag.started && tabDrag.targetId) {
      const fromIndex = documents.findIndex((note) => note.id === tabDrag.id);
      const [moved] = documents.splice(fromIndex, 1);
      const targetIndex = documents.findIndex((note) => note.id === tabDrag.targetId);
      if (moved && targetIndex >= 0) {
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
    if (!button) {
      return;
    }
    fileMenu.hidden = true;
    fileMenuTrigger.setAttribute('aria-expanded', 'false');
    window.electronAPI.executeCommand(button.dataset.command).catch((error) => {
      setStatus(`Could not run command: ${error.message}`);
    });
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.file-menu')) {
      fileMenu.hidden = true;
      fileMenuTrigger.setAttribute('aria-expanded', 'false');
    }
  });

  editor.addEventListener('input', () => {
    const document = activeDocument();
    if (!document) {
      return;
    }
    const addition = findInsertedText(document.content, editor.value);
    document.content = editor.value;
    document.revision += 1;
    document.dirty = true;
    if (addition) {
      document.additions.unshift({
        text: addition,
        timestamp: new Date().toISOString(),
      });
      document.additions.length = Math.min(document.additions.length, 20);
      renderTimeline(document);
    }
    refreshDirtyState();
    scheduleAutoSave(document);
    updateCursorPosition();
  });
  editor.addEventListener('click', updateCursorPosition);
  editor.addEventListener('keyup', updateCursorPosition);

  document.getElementById('save-settings').addEventListener('click', async (event) => {
    event.preventDefault();
    if (!fontSizeInput.reportValidity()) {
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
      if (!autoSave) {
        setStatus('Auto-save is off');
      }
    } catch (error) {
      setStatus(`Could not save settings: ${error.message}`);
    }
  });

  function handleCommand(command) {
    switch (command) {
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
  window.electronAPI.onCommand(handleCommand);
  window.electronAPI.window.onCloseRequested(closeWindowAfterCheckingNotes);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !searchBar.hidden) {
      searchBar.hidden = true;
    }
    if (event.key === 'Enter' && searchBar.contains(document.activeElement)) {
      event.preventDefault();
      search(event.shiftKey ? -1 : 1);
    }
  });
  window.addEventListener('blur', () => body.classList.add('inactive'));
  window.addEventListener('focus', () => body.classList.remove('inactive'));

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
