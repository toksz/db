// ╔═══════════════════════════════════════════════════════╗
// ║  CONSTANTS & STATE                                   ║
// ╚═══════════════════════════════════════════════════════╝
const DAYS_DE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const LS_KEY = 'strieder_dispobuch_state';
const LS_MODE = 'strieder_dispobuch_mode';

let state = {
  version: 0,
  niederlassungen: ['Gießen'],
  tours: {}
};
let activeNL = null;
let weekOffset = 0;
let fileHandle = null;   // File System Access API handle
let fileMode = 'local'; // 'file' | 'local'
let pollTimer = null;
let syncTimer = null;
let lastFileVersion = 0;
let lastFileModified = 0;     // file.lastModified — cheap pre-check before full read
let isSaving = false;
let pollInterval = 2500;
let fastPollInterval = 800;
let checking = false;
let activeForms = {};     // ds -> open form ds keys

// ╔═══════════════════════════════════════════════════════╗
// ║  INDEXEDDB HANDLE PERSISTENCE                        ║
// ╚═══════════════════════════════════════════════════════╝
const DB_NAME = 'DispoBookDB';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'current_file_handle';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeHandle(handle) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { console.warn('IDB store error', e); }
}

async function getStoredHandle() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (e) { return null; }
}

function getDefaultState() {
  return { version: Date.now(), niederlassungen: ['Gießen'], tours: {}, deletedTours: {} };
}

async function loadInitialFile(handle) {
  // Start fresh
  state = getDefaultState();

  const file = await handle.getFile();
  const text = await file.text();
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        state = parsed;
      }
    } catch (e) {
      console.error('Failed to parse data.json', e);
      toast('Datei ist beschädigt oder kein gültiges JSON. Starte mit leerer Datenbank.', 'warning');
    }
  }

  // Ensure basic structure exists even after parse
  if (!state.niederlassungen) state.niederlassungen = ['Gießen'];
  if (!state.tours) state.tours = {};
  if (!state.deletedTours) state.deletedTours = {};

  lastFileVersion = state.version || 0;
  lastFileModified = file.lastModified;
}

async function reconnectFile() {
  const handle = await getStoredHandle();
  if (!handle) { pickFile(); return; }
  try {
    const options = { mode: 'readwrite' };
    if (await handle.requestPermission(options) === 'granted') {
      fileHandle = handle;
      fileMode = 'file';
      localStorage.setItem(LS_MODE, 'file');
      await loadInitialFile(handle);
      showApp();
      setSyncState('saved');
      toast('Datei erfolgreich re-aktiviert ✓', 'success');
    } else {
      toast('Schreibzugriff wurde verweigert.', 'warning');
    }
  } catch (e) {
    console.warn('Reconnect failed', e);
    toast('Fehler beim Re-aktivieren. Bitte Datei neu wählen.', 'warning');
  }
}

function resetAppToSetup() {
  if (pollTimer) clearTimeout(pollTimer);
  if (syncTimer) clearTimeout(syncTimer);
  fileHandle = null;
  fileMode = 'local';
  state = getDefaultState(); // Clear memory
  localStorage.removeItem(LS_MODE);
  // We don't remove the DB handle from IDB here, just the current session's mode
  // This allows the "Reconnect" area to still show up if they go back to setup
  document.getElementById('fileSetup').style.display = 'flex';
  document.getElementById('app').style.display = 'none';

  // Update Setup UI
  const reconnectArea = document.getElementById('reconnectArea');
  if (reconnectArea) reconnectArea.style.display = 'block';
  const pickBtn = document.getElementById('pickFileBtn');
  if (pickBtn) pickBtn.textContent = 'Andere Datenbankdatei wählen';

  toast('Zurück zur Einrichtung', 'info');
}

(async function boot() {
  const savedMode = localStorage.getItem(LS_MODE);
  const storedHandle = await getStoredHandle();

  // UI state for Setup: if we have a handle, show the beautiful Grant Access area
  // (reconnectArea / pickFileBtn are optional elements)

  if (savedMode === 'file' && storedHandle) {
    try {
      const options = { mode: 'readwrite' };
      let status = await storedHandle.queryPermission(options);
      if (status === 'granted') {
        fileHandle = storedHandle;
        fileMode = 'file';
        await loadInitialFile(storedHandle);
        showApp();
        setSyncState('saved');
        toast('Datei automatisch verbunden ✓', 'success');
        return;
      }
    } catch (e) { console.warn('Auto-boot failed', e); }
  }

  if (savedMode === 'local') {
    fileMode = 'local';
    loadFromLS();
    showApp();
  } else {
    document.getElementById('fileSetup').style.display = 'flex';
  }
})();

function showApp() {
  document.getElementById('fileSetup').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  if (!activeNL) activeNL = state.niederlassungen[0] || 'Gießen';
  render();
  if (fileMode === 'file' && fileHandle) startPolling();
  else startLocalPolling();
}

// ╔═══════════════════════════════════════════════════════╗
// ║  FILE SYSTEM ACCESS API                              ║
// ╚═══════════════════════════════════════════════════════╝
async function pickFile() {
  if (!('showOpenFilePicker' in window)) {
    toast('Ihr Browser unterstützt die File-API nicht. Bitte Chrome oder Edge verwenden.', 'warning');
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      suggestedName: 'data.json',
      types: [{ description: 'DispoBook JSON', accept: { 'application/json': ['.json'] } }],
      multiple: false
    });
    fileHandle = handle;
    await storeHandle(handle);
    fileMode = 'file';
    localStorage.setItem(LS_MODE, 'file');

    await loadInitialFile(handle);

    showApp();
    toast('Datei verbunden — Echtzeit-Sync aktiv', 'success');
  } catch (e) {
    if (e.name !== 'AbortError') {
      // try create new
      tryCreateFile();
    }
  }
}

async function createNewFile() { await tryCreateFile(); }

async function tryCreateFile() {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'data.json',
      types: [{ description: 'DispoBook JSON', accept: { 'application/json': ['.json'] } }]
    });
    fileHandle = handle;
    await storeHandle(handle);
    fileMode = 'file';
    localStorage.setItem(LS_MODE, 'file');
    state = { version: Date.now(), niederlassungen: ['Gießen'], tours: {}, deletedTours: {} };
    await writeFile();
    showApp();
    toast('Neue Datenbankdatei erstellt ✓', 'success');
  } catch (e) {
    if (e.name !== 'AbortError') toast('Fehler beim Erstellen der Datei', 'warning');
  }
}

// ╔═══════════════════════════════════════════════════════╗
// ║  OPTIMIZED FILE SYNC ENGINE                           ║
// ╚═══════════════════════════════════════════════════════╝
async function verifyPermission(handle, mode = 'readwrite') {
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

async function writeFile() {
  if (!fileHandle) { saveToLS(); return; }
  try {
    if (!(await verifyPermission(fileHandle)))
      throw new Error("No permission");

    const newVersion = Date.now();
    state.version = newVersion;

    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(state, null, 2));
    await writable.close();

    lastFileVersion = newVersion;

    const f = await fileHandle.getFile();
    lastFileModified = f.lastModified;

    setSyncState("saved");
    return true;
  } catch (e) {
    console.warn("Write error", e);
    saveToLS(); // fallback
    setSyncState("error");
    toast("Schreibrechte verloren – bitte Datei erneut verbinden", "warning");
    return false;
  }
}

async function checkExternalChanges() {
  if (checking) return;
  if (!fileHandle) return;
  if (document.hidden) return;
  if (isSaving) return;
  if (dragSrc) return;

  checking = true;

  try {
    const f = await fileHandle.getFile();

    if (f.lastModified <= lastFileModified) {
      checking = false;
      return;
    }

    const text = await f.text();
    let remote;

    try {
      remote = JSON.parse(text);
    } catch {
      checking = false;
      return;
    }

    lastFileModified = f.lastModified;

    if (!remote.version || remote.version <= lastFileVersion) {
      checking = false;
      return;
    }

    // Check if user is actively typing in any add-form
    const userIsTyping = document.activeElement &&
      (document.activeElement.classList.contains('add-form-input') ||
        document.activeElement.classList.contains('modal-input'));

    if (userIsTyping) {
      // defer — show banner so they can decide when ready
      window._remoteState = remote;
      document.getElementById('conflictBanner').classList.add('visible');
    } else {
      // Silent auto-merge — flash only changed columns
      await applyRemote(remote, true);
    }

  } catch (e) {
    console.warn("Polling error", e);
  }

  checking = false;
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  // Use faster interval if tab is focused
  const currentInterval = document.hidden ? pollInterval : fastPollInterval;
  pollTimer = setInterval(checkExternalChanges, currentInterval);
}

// High-frequency triggers
window.addEventListener('focus', () => {
  // Immediate check when user clicks back into the tab
  checkExternalChanges();
  // Switch to fast polling
  startPolling();
});

window.addEventListener('blur', () => {
  // Switch back to slower baseline polling when out of focus
  startPolling();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(pollTimer);
    return;
  }
  startPolling();
  setTimeout(checkExternalChanges, 100);
});

async function applyRemote(remote, silent) {
  // ── CRDT-style merge using updated timestamps and tombstones ──
  const merged = {
    version: Math.max(state.version || 0, remote.version || 0),
    niederlassungen: Array.from(new Set([...(state.niederlassungen || []), ...(remote.niederlassungen || [])])),
    tours: {},
    deletedTours: { ...(state.deletedTours || {}), ...(remote.deletedTours || {}) }
  };

  const tourMap = {};

  function collect(sourceState) {
    if (!sourceState.tours) return;
    Object.keys(sourceState.tours).forEach(nl => {
      Object.keys(sourceState.tours[nl]).forEach(dsKey => {
        ['pending', 'done'].forEach(status => {
          sourceState.tours[nl][dsKey][status].forEach(t => {
            const existing = tourMap[t.id];
            const tUpdated = t.updated || t.created || 0;
            const eUpdated = existing ? (existing.updated || existing.created || 0) : -1;
            // Add to map if it's not and existing or if current iteration has a newer timestamp
            if (!existing || eUpdated < tUpdated) {
              tourMap[t.id] = { ...t, updated: tUpdated, _nl: nl, _ds: dsKey, _status: status };
            }
          });
        });
      });
    });
  }

  collect(remote);
  collect(state); // We collect local state second so that on exact same timestamp, local wins

  Object.values(tourMap).forEach(t => {
    // Drop it if there's a tombstone for this id that is newer than or equal to the tour's last update
    if (merged.deletedTours[t.id] && merged.deletedTours[t.id] >= t.updated) return;

    const nl = t._nl;
    const dsKey = t._ds;
    const status = t._status;
    delete t._nl; delete t._ds; delete t._status;

    if (!merged.tours[nl]) merged.tours[nl] = {};
    if (!merged.tours[nl][dsKey]) merged.tours[nl][dsKey] = { pending: [], done: [] };
    merged.tours[nl][dsKey][status].push(t);
  });

  // ── figure out which day-columns changed for rendering flash ──
  const changedDays = new Set();
  merged.niederlassungen.forEach(nl => {
    const localNL = (state.tours || {})[nl] || {};
    const mergedNL = (merged.tours || {})[nl] || {};
    const allDays = new Set([...Object.keys(localNL), ...Object.keys(mergedNL)]);
    allDays.forEach(dsKey => {
      const loc = localNL[dsKey] || { pending: [], done: [] };
      const mrg = mergedNL[dsKey] || { pending: [], done: [] };
      const locSig = [...loc.pending, ...loc.done].map(t => t.id).sort().join(',');
      const mrgSig = [...mrg.pending, ...mrg.done].map(t => t.id).sort().join(',');
      if (locSig !== mrgSig) changedDays.add(dsKey);
    });
  });

  state = merged;
  lastFileVersion = state.version;
  saveToLS();
  document.getElementById('conflictBanner').classList.remove('visible');
  render();
  setSyncState('saved');

  if (!silent) {
    toast('Daten zusammengeführt ✓', 'success');
  } else if (changedDays.size > 0) {
    // ── flash only the columns that actually changed ──
    changedDays.forEach(dsKey => {
      const zones = document.querySelectorAll(`[data-ds="${dsKey}"]`);
      zones.forEach(z => {
        const col = z.closest('.day-col');
        if (col) {
          col.classList.remove('remote-flash');
          void col.offsetWidth; // force reflow to restart animation
          col.classList.add('remote-flash');
          setTimeout(() => col.classList.remove('remote-flash'), 1500);
        }
      });
    });

    // ── show badge in header ──
    const badge = document.getElementById('syncBadge');
    const dot = document.getElementById('syncDot');
    const lbl = document.getElementById('syncLabel');
    if (badge) {
      badge.classList.add('visible');
      dot.className = 'sync-dot updated';
      lbl.textContent = changedDays.size === 1
        ? '1 Tag aktualisiert'
        : `${changedDays.size} Tage aktualisiert`;
      setTimeout(() => {
        badge.classList.remove('visible');
        setSyncState('saved');
      }, 3500);
    }

    toast(`🔄 ${changedDays.size} Änderung${changedDays.size > 1 ? 'en' : ''} von anderem Nutzer`, 'success');
  }
}

async function mergeAndReload() {
  const remote = window._remoteState;
  if (!remote) return;
  await applyRemote(remote, false);
}

function useLocalOnly() {
  fileMode = 'local';
  localStorage.setItem(LS_MODE, 'local');
  loadFromLS();
  showApp();
  toast('Lokaler Modus — Daten werden im Browser gespeichert', 'warning');
}

// ── BroadcastChannel: instant same-browser multi-tab sync ──
let bc;
try {
  bc = new BroadcastChannel('strieder_dispobuch');
  bc.onmessage = (e) => {
    if (e.data && e.data.type === 'update' && e.data.version > lastFileVersion) {
      // another tab saved — reload from LS
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        try {
          const remote = JSON.parse(saved);
          if (remote.version > lastFileVersion) applyRemote(remote, true);
        } catch (err) { }
      }
    }
  };
} catch (err) { bc = null; }

// ╔═══════════════════════════════════════════════════════╗
// ║  LOCAL STORAGE FALLBACK                              ║
// ╚═══════════════════════════════════════════════════════╝
function saveToLS() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
function loadFromLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state = parsed;
        return;
      }
    }
  } catch (e) { }
  state = getDefaultState();
  reconcileState();
}

// ╔═══════════════════════════════════════════════════════╗
// ║  SAVE ORCHESTRATION                                  ║
// ╚═══════════════════════════════════════════════════════╝
function scheduleSave() {
  setSyncState('saving');
  clearTimeout(syncTimer);
  // 100 ms debounce — feels instant, still coalesces rapid keystrokes
  syncTimer = setTimeout(doSave, 100);
}

async function doSave() {
  isSaving = true;
  saveToLS();
  if (bc) bc.postMessage({ type: 'update', version: Date.now() });

  let success = true;
  if (fileMode === 'file') {
    if (fileHandle) {
      success = await writeFile();
    } else {
      success = false;
    }
  }
  isSaving = false;
  setSyncState(success ? 'saved' : 'error');
}

function setSyncState(s) {
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  if (!dot) return;
  dot.className = 'sync-dot' + (s === 'saving' ? ' saving' : s === 'error' ? ' error' : '');

  const modeStr = (fileMode === 'file' ? 'Datei' : 'Lokal');
  if (s === 'saving') {
    label.textContent = 'Speichert ( ' + modeStr + ' ) …';
  } else if (s === 'error') {
    label.textContent = 'Fehler ( ' + modeStr + ' )';
  } else {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    label.textContent = 'Gespeichert ' + timeStr + ' (' + modeStr + ')';
  }
}

// Local-mode polling: re-read localStorage every 500 ms (catches other browser tabs)
function startLocalPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (isSaving) return;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const remote = JSON.parse(raw);
      if (remote.version && remote.version > (state.version || 0)) {
        state = remote;
        render();
        const dot = document.getElementById('syncDot');
        const lbl = document.getElementById('syncLabel');
        if (dot && lbl) {
          dot.style.background = 'var(--blue-bdr)';
          lbl.textContent = 'Aktualisiert';
          setTimeout(() => { dot.style.background = ''; setSyncState('saved'); }, 2000);
        }
      }
    } catch (e) { }
  }, 500);
}

// ╔═══════════════════════════════════════════════════════╗
// ║  DATA HELPERS                                        ║
// ╚═══════════════════════════════════════════════════════╝
function nlData(nl) { if (!state.tours[nl]) state.tours[nl] = {}; return state.tours[nl]; }
function dayData(nl, ds) { const d = nlData(nl); if (!d[ds]) d[ds] = { pending: [], done: [] }; return d[ds]; }
function uid() { return Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

function addTour(nl, ds, name, status) {
  dayData(nl, ds)[status].push({ id: uid(), name: name.trim(), created: Date.now(), updated: Date.now() });
  scheduleSave(); render();
}
function removeTour(nl, ds, status, id) {
  const d = dayData(nl, ds);
  d[status] = d[status].filter(t => t.id !== id);
  if (!state.deletedTours) state.deletedTours = {};
  state.deletedTours[id] = Date.now();
  scheduleSave(); render();
}
function toggleStatus(nl, ds, from, id) {
  const to = from === 'pending' ? 'done' : 'pending';
  const d = dayData(nl, ds);
  const idx = d[from].findIndex(t => t.id === id);
  if (idx === -1) return;
  const [t] = d[from].splice(idx, 1);
  t.updated = Date.now();
  d[to].push(t);
  scheduleSave(); render();
}

// ╔═══════════════════════════════════════════════════════╗
// ║  WEEK HELPERS                                        ║
// ╚═══════════════════════════════════════════════════════╝
function getMonday(off = 0) {
  const now = new Date(); const dw = now.getDay();
  const diff = dw === 0 ? -6 : 1 - dw;
  const m = new Date(now); m.setDate(now.getDate() + diff + off * 7); m.setHours(0, 0, 0, 0); return m;
}
function ds(d) {
  // Avoid UTC shifting (Monday 00:00 UTC+1 -> Sunday 23:00 UTC)
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function fmt(d) { return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); }
function isToday(d) { return ds(d) === ds(new Date()); }
function kw(d) {
  const u = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  u.setUTCDate(u.getUTCDate() + 4 - (u.getUTCDay() || 7));
  const y = new Date(Date.UTC(u.getUTCFullYear(), 0, 1));
  return Math.ceil((((u - y) / 86400000) + 1) / 7);
}
function changeWeek(dir) { weekOffset += dir; render(); }
function goToToday() { weekOffset = 0; render(); }

// ╔═══════════════════════════════════════════════════════╗
// ║  NIEDERLASSUNGEN                                     ║
// ╚═══════════════════════════════════════════════════════╝
function openAddNL() {
  document.getElementById('nlNameInput').value = '';
  document.getElementById('nlModal').classList.add('open');
  setTimeout(() => document.getElementById('nlNameInput').focus(), 60);
}
function confirmAddNL() {
  const v = document.getElementById('nlNameInput').value.trim();
  if (!v) { toast('Bitte Namen eingeben', 'warning'); return; }
  if (state.niederlassungen.includes(v)) { toast('Niederlassung existiert bereits', 'warning'); return; }
  state.niederlassungen.push(v);
  activeNL = v; scheduleSave(); closeModal('nlModal'); render();
  toast('Niederlassung "' + v + '" erstellt', 'success');
}
function removeNL(nl, e) {
  e.stopPropagation();
  if (state.niederlassungen.length <= 1) { toast('Mindestens eine Niederlassung erforderlich', 'warning'); return; }
  if (!confirm('"' + nl + '" und alle Touren dieser Niederlassung löschen?')) return;
  state.niederlassungen = state.niederlassungen.filter(n => n !== nl);
  delete state.tours[nl];
  if (activeNL === nl) activeNL = state.niederlassungen[0];
  scheduleSave(); render();
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ╔═══════════════════════════════════════════════════════╗
// ║  INLINE ADD FORM                                     ║
// ╚═══════════════════════════════════════════════════════╝
function openAddForm(dsKey) {
  // close others
  document.querySelectorAll('.add-form.open').forEach(f => closeAddForm(f.dataset.ds));
  const trigger = document.getElementById('add-trigger-' + dsKey);
  const form = document.getElementById('add-form-' + dsKey);
  if (!trigger || !form) return;
  trigger.style.display = 'none';
  form.classList.add('open');
  form.dataset.ds = dsKey;
  const inp = document.getElementById('add-inp-' + dsKey);
  if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 30); }
  activeForms[dsKey] = true;
}
function closeAddForm(dsKey) {
  const trigger = document.getElementById('add-trigger-' + dsKey);
  const form = document.getElementById('add-form-' + dsKey);
  if (trigger) trigger.style.display = '';
  if (form) form.classList.remove('open');
  delete activeForms[dsKey];
}
function submitAddForm(nl, dsKey) {
  const inp = document.getElementById('add-inp-' + dsKey);
  const sel = document.getElementById('add-sel-' + dsKey);
  if (!inp) return;
  const name = inp.value.trim();
  if (!name) { inp.classList.add('shake'); setTimeout(() => inp.classList.remove('shake'), 400); return; }
  addTour(nl, dsKey, name, sel ? sel.value : 'pending');
  inp.value = '';
  setTimeout(() => inp.focus(), 30);
  toast('Tour "' + name + '" hinzugefügt', 'success');
}

// ╔═══════════════════════════════════════════════════════╗
// ║  DRAG & DROP                                         ║
// ╚═══════════════════════════════════════════════════════╝
let dragSrc = null;

function onDragStart(e, card) {
  dragSrc = { nl: card.dataset.nl, ds: card.dataset.ds, status: card.dataset.status, id: card.dataset.id };
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.dataset.id);
}
document.addEventListener('dragend', () => {
  document.querySelectorAll('.tour-card.dragging').forEach(c => c.classList.remove('dragging'));
  document.querySelectorAll('.drop-zone.over').forEach(z => z.classList.remove('over'));
  document.querySelectorAll('.day-col.drag-target').forEach(c => c.classList.remove('drag-target'));
  dragSrc = null;
});

function onDragOver(e, zone) {
  e.preventDefault(); e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  zone.classList.add('over');
  zone.closest('.day-col')?.classList.add('drag-target');
}
function onDragLeave(e, zone) {
  if (!zone.contains(e.relatedTarget)) {
    zone.classList.remove('over');
    // only remove drag-target if no child zones are over
    const col = zone.closest('.day-col');
    if (col && !col.querySelector('.drop-zone.over')) col.classList.remove('drag-target');
  }
}
function onDrop(e, zone) {
  e.preventDefault(); zone.classList.remove('over');
  zone.closest('.day-col')?.classList.remove('drag-target');
  if (!dragSrc) return;
  const toNL = zone.dataset.nl, toDs = zone.dataset.ds, toSt = zone.dataset.status;
  // remove from source
  const src = dayData(dragSrc.nl, dragSrc.ds);
  const idx = src[dragSrc.status].findIndex(t => t.id === dragSrc.id);
  if (idx === -1) return;
  const [tour] = src[dragSrc.status].splice(idx, 1);
  // update timestamp
  tour.updated = Date.now();
  // add to target
  dayData(toNL, toDs)[toSt].push(tour);
  dragSrc = null;
  scheduleSave(); render();
  toast('Tour verschoben');
}

// ╔═══════════════════════════════════════════════════════╗
// ║  RENDER ENGINE                                       ║
// ╚═══════════════════════════════════════════════════════╝
function render() {
  if (!activeNL && state.niederlassungen.length) activeNL = state.niederlassungen[0];
  renderTabs();
  renderStats();
  renderGrid();
  updateWeekLabel();
}

function updateWeekLabel() {
  const mon = getMonday(weekOffset);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const el = document.getElementById('weekLabel');
  if (el) el.textContent = 'KW ' + kw(mon) + ' · ' + fmt(mon) + ' – ' + fmt(sun);
}

function renderTabs() {
  const bar = document.getElementById('nlTabs');
  if (!bar) return;
  const addBtn = bar.querySelector('.nl-add-btn');
  bar.querySelectorAll('.nl-tab').forEach(t => t.remove());

  state.niederlassungen.forEach(nl => {
    // count tours this week
    const mon = getMonday(weekOffset);
    let cnt = 0;
    for (let i = 0; i < 7; i++) {
      const d = dayData(nl, ds(new Date(mon.getTime() + i * 86400000)));
      cnt += d.pending.length + d.done.length;
    }
    const tab = document.createElement('div');
    tab.className = 'nl-tab' + (nl === activeNL ? ' active' : '');
    tab.innerHTML = `
      <span>${escHtml(nl)}</span>
      <span class="nl-tab-count">${cnt}</span>
      <button class="nl-tab-del" onclick="removeNL('${escAttr(nl)}',event)" title="Niederlassung löschen">✕</button>`;
    tab.addEventListener('click', e => {
      if (e.target.closest('.nl-tab-del')) return;
      activeNL = nl; render();
    });
    bar.insertBefore(tab, addBtn);
  });
}

function renderStats() {
  const row = document.getElementById('statsRow');
  if (!row) return;
  const mon = getMonday(weekOffset);
  let pend = 0, done = 0;
  for (let i = 0; i < 7; i++) {
    const d = dayData(activeNL, ds(new Date(mon.getTime() + i * 86400000)));
    pend += d.pending.length; done += d.done.length;
  }
  const total = pend + done;
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  row.innerHTML = `
    <div class="stat-pill">
      <span class="stat-pip" style="background:var(--amber-bdr)"></span>
      Ausstehend: <strong>${pend}</strong>
    </div>
    <div class="stat-pill">
      <span class="stat-pip" style="background:var(--green-bdr)"></span>
      Disponiert: <strong>${done}</strong>
    </div>
    <div class="stat-pill">
      Gesamt: <strong>${total}</strong>
    </div>
    <div class="stat-pill">
      Fortschritt: <strong>${pct}%</strong>
    </div>
    `;
}

function renderGrid() {
  const grid = document.getElementById('daysGrid');
  if (!grid) return;
  // preserve open forms
  const openDs = Object.keys(activeForms);
  grid.innerHTML = '';
  const mon = getMonday(weekOffset);

  if (!activeNL) {
    grid.innerHTML = '<div class="nl-empty"><div class="nl-empty-icon">🗂️</div><div class="nl-empty-title">Keine Niederlassung</div><div class="nl-empty-sub">Fügen Sie eine Niederlassung hinzu, um zu beginnen.</div></div>';
    return;
  }

  for (let i = 0; i < 7; i++) {
    const date = new Date(mon.getTime() + i * 86400000);
    const dsKey = ds(date);
    const data = dayData(activeNL, dsKey);
    grid.appendChild(buildDayCol(DAYS_DE[i], date, dsKey, data));
  }

  // re-open forms that were open
  openDs.forEach(dsKey => {
    if (document.getElementById('add-trigger-' + dsKey)) openAddForm(dsKey);
  });
}

function buildDayCol(dayName, date, dsKey, data) {
  const col = document.createElement('div');
  col.className = 'day-col' + (isToday(date) ? ' today' : '');

  const total = data.pending.length + data.done.length;

  col.innerHTML = `
    <div class="day-head">
      <div>
        <div class="day-name">${dayName}${isToday(date) ? '<span class="today-badge">Heute</span>' : ''}</div>
        <div class="day-date">${fmt(date)}</div>
      </div>
      <span class="day-total">${total}</span>
    </div>

    <div class="section section-pending">
      <div class="section-head">
        <span class="section-title">Ausstehend</span>
        <span class="section-count">${data.pending.length}</span>
      </div>
      <div class="drop-zone" id="dz-${dsKey}-pending"
        data-nl="${escAttr(activeNL)}" data-ds="${dsKey}" data-status="pending"
        ondragover="onDragOver(event,this)" ondragleave="onDragLeave(event,this)" ondrop="onDrop(event,this)">
        ${data.pending.length === 0
      ? '<div class="drop-empty">Keine ausstehenden Touren</div>'
      : data.pending.map(t => buildCard(t, activeNL, dsKey, 'pending')).join('')}
      </div>
    </div>

    <div class="section section-done">
      <div class="section-head">
        <span class="section-title">Disponiert</span>
        <span class="section-count">${data.done.length}</span>
      </div>
      <div class="drop-zone" id="dz-${dsKey}-done"
        data-nl="${escAttr(activeNL)}" data-ds="${dsKey}" data-status="done"
        ondragover="onDragOver(event,this)" ondragleave="onDragLeave(event,this)" ondrop="onDrop(event,this)">
        ${data.done.length === 0
      ? '<div class="drop-empty">Noch keine disponierten Touren</div>'
      : data.done.map(t => buildCard(t, activeNL, dsKey, 'done')).join('')}
      </div>
    </div>

    <div class="add-zone">
      <button class="add-trigger" id="add-trigger-${dsKey}" onclick="openAddForm('${dsKey}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Tour hinzufügen
      </button>
      <div class="add-form" id="add-form-${dsKey}" data-ds="${dsKey}">
        <input class="add-form-input" id="add-inp-${dsKey}" type="text"
          placeholder="Tourname eingeben …"
          onkeydown="handleFormKey(event,'${escAttr(activeNL)}','${dsKey}')">
        <div class="add-form-row">
          <select class="add-form-select" id="add-sel-${dsKey}">
            <option value="pending">⏳ Ausstehend</option>
            <option value="done">✓ Disponiert</option>
          </select>
          <button class="add-form-submit" onclick="submitAddForm('${escAttr(activeNL)}','${dsKey}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Hinzufügen
          </button>
          <button class="add-form-cancel" onclick="closeAddForm('${dsKey}')">Abbrechen</button>
        </div>
        <div class="add-hint">Enter = Hinzufügen · Escape = Schließen</div>
      </div>
    </div>`;

  return col;
}

function buildCard(tour, nl, dsKey, status) {
  const toggleIco = status === 'pending'
    ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.29"/></svg>';
  const toggleTitle = status === 'pending' ? 'Als disponiert markieren' : 'Zurück zu ausstehend';
  return `<div class="tour-card ${status}"
    draggable="true"
    data-nl="${escAttr(nl)}" data-ds="${dsKey}" data-status="${status}" data-id="${tour.id}"
    ondragstart="onDragStart(event,this)">
    <span class="tour-drag-handle">⠿</span>
    <span class="tour-name" title="${escHtml(tour.name)}" ondblclick="startEditTour('${escAttr(nl)}','${dsKey}','${status}','${tour.id}',this)">${escHtml(tour.name)}</span>
    <span class="tour-btns">
      <button class="tour-btn toggle" title="${toggleTitle}"
        onclick="toggleStatus('${escAttr(nl)}','${dsKey}','${status}','${tour.id}')">${toggleIco}</button>
      <button class="tour-btn del" title="Löschen"
        onclick="removeTour('${escAttr(nl)}','${dsKey}','${status}','${tour.id}')">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </span>
  </div>`;
}

// ╔═══════════════════════════════════════════════════════╗
// ║  INLINE TOUR NAME EDIT                               ║
// ╚═══════════════════════════════════════════════════════╝
function startEditTour(nl, dsKey, status, id, nameEl) {
  if (nameEl.querySelector('input')) return; // already editing
  const card = nameEl.closest('.tour-card');
  if (card) card.setAttribute('draggable', 'false');

  const currentName = nameEl.textContent;
  nameEl.textContent = '';

  const inp = document.createElement('input');
  inp.className = 'tour-edit-input';
  inp.value = currentName;
  inp.setAttribute('data-editing', '1');
  nameEl.appendChild(inp);

  inp.focus();
  inp.select();

  function commit() {
    const newName = inp.value.trim();
    if (card) card.setAttribute('draggable', 'true');
    if (!newName || newName === currentName) { render(); return; }
    const d = dayData(nl, dsKey);
    const t = d[status].find(x => x.id === id);
    if (t) { t.name = newName; t.updated = Date.now(); scheduleSave(); }
    render();
  }

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); if (card) card.setAttribute('draggable', 'true'); render(); }
  });
  inp.addEventListener('blur', commit);
}

function handleFormKey(e, nl, dsKey) {
  if (e.key === 'Enter') { e.preventDefault(); submitAddForm(nl, dsKey); }
  if (e.key === 'Escape') { e.preventDefault(); closeAddForm(dsKey); }
}

// ╔═══════════════════════════════════════════════════════╗
// ║  EXPORT                                              ║
// ╚═══════════════════════════════════════════════════════╝
function allRows() {
  const rows = [['Niederlassung', 'Datum', 'Wochentag', 'Status', 'Tour', 'Erstellt']];
  state.niederlassungen.forEach(nl => {
    const d = nlData(nl);
    Object.keys(d).sort().forEach(dsKey => {
      const day = d[dsKey]; const date = new Date(dsKey);
      const wt = DAYS_DE[date.getDay() === 0 ? 6 : date.getDay() - 1] || '';
      ['pending', 'done'].forEach(st => {
        day[st].forEach(t => {
          rows.push([nl, dsKey, wt, st === 'pending' ? 'Ausstehend' : 'Disponiert', t.name,
            t.created ? new Date(t.created).toLocaleString('de-DE') : '']);
        });
      });
    });
  });
  return rows;
}

function exportCSV() {
  const rows = allRows();
  const csv = rows.map(r => r.map(c => '"' + String(c || '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
  dl('\uFEFF' + csv, 'strieder_dispobuch_' + ds(new Date()) + '.csv', 'text/csv');
  toast('CSV exportiert', 'success');
}

function exportExcel() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(allRows());
  ws['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 34 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Alle Touren');
  state.niederlassungen.forEach(nl => {
    const rows = [['Datum', 'Wochentag', 'Status', 'Tour', 'Erstellt']];
    const d = nlData(nl);
    Object.keys(d).sort().forEach(dsKey => {
      const day = d[dsKey]; const date = new Date(dsKey);
      const wt = DAYS_DE[date.getDay() === 0 ? 6 : date.getDay() - 1] || '';
      ['pending', 'done'].forEach(st => {
        day[st].forEach(t => rows.push([dsKey, wt, st === 'pending' ? 'Ausstehend' : 'Disponiert', t.name,
          t.created ? new Date(t.created).toLocaleString('de-DE') : '']));
      });
    });
    const nlWs = XLSX.utils.aoa_to_sheet(rows);
    nlWs['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 34 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, nlWs, nl.slice(0, 31).replace(/[:\\\/\?\*\[\]]/g, '_'));
  });
  XLSX.writeFile(wb, 'strieder_dispobuch_' + ds(new Date()) + '.xlsx');
  toast('Excel exportiert', 'success');
}

function dl(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ╔═══════════════════════════════════════════════════════╗
// ║  TOAST                                               ║
// ╚═══════════════════════════════════════════════════════╝
function toast(msg, type = '') {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast-item' + (type ? ' ' + type : '');
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 2400);
}

// ╔═══════════════════════════════════════════════════════╗
// ║  UTILS                                               ║
// ╚═══════════════════════════════════════════════════════╝
function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function escAttr(s) { return String(s || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;'); }

// Global keyboard
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
    // close all add forms
    document.querySelectorAll('.add-form.open').forEach(f => {
      const dsKey = f.dataset.ds; if (dsKey) closeAddForm(dsKey);
    });
    const dd = document.getElementById('downloadDropdown'); if (dd) dd.classList.remove('show');
  }
});

// Global click for closing simple dropdowns
document.addEventListener('click', (event) => {
  const menu = document.getElementById('exportMenu');
  if (menu && menu.style.display !== 'none' && !event.target.closest('.dropdown')) {
    menu.style.display = 'none';
  }
});

window.onload = function () {
  if (localStorage.getItem('theme') === 'dark') {
    document.documentElement.classList.add('dark-mode');
    updateThemeIcon(true);
  } else {
    updateThemeIcon(false);
  }
}

// ╔═══════════════════════════════════════════════════════╗
// ║  THEME & DROPDOWN                                    ║
// ╚═══════════════════════════════════════════════════════╝
function toggleDarkMode() {
  const isDark = document.documentElement.classList.toggle('dark-mode');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  updateThemeIcon(isDark);
}

function updateThemeIcon(isDark) {
  // Find the SVG inside the dark mode toggle button
  const btn = document.querySelector('button[title="Dark Mode umschalten"]');
  if (!btn) return;
  if (isDark) {
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>';
  } else {
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
  }
}

function toggleExportMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('exportMenu');
  if (menu.style.display === 'none' || menu.style.display === '') {
    menu.style.display = 'flex';
  } else {
    menu.style.display = 'none';
  }
}

function handleExportClick(format) {
  if (format === 'csv') exportCSV();
  if (format === 'excel') exportExcel();
  document.getElementById('exportMenu').style.display = 'none';
}

document.querySelectorAll('.modal-backdrop').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
});

// ── Aliases & missing functions for HTML bindings ──
function openModal(id) {
  const backdrop = document.getElementById(id + '-backdrop');
  const modal = document.getElementById(id);
  if (backdrop) backdrop.classList.add('open');
  if (modal) modal.classList.add('open');
  // Focus first input inside modal
  setTimeout(() => {
    const inp = modal && modal.querySelector('input');
    if (inp) inp.focus();
  }, 60);
}
function openFileMenu() { openModal('fileMenu'); }
function handleExport() { exportExcel(); }
function goToday() { goToToday(); }

let _editDispCtx = null;
function openEditDisp(nl, dsKey, status, id, name) {
  _editDispCtx = { nl, dsKey, status, id };
  document.getElementById('editDispNameInput').value = name;
  openModal('editDispModal');
}
function confirmAddDisp() {
  const v = document.getElementById('dispNameInput').value.trim();
  if (!v) { toast('Bitte Namen eingeben', 'warning'); return; }
  if (activeNL) addTour(activeNL, ds(getMonday(weekOffset)), v, 'pending');
  closeModal('addDispModal');
}
function confirmEditDisp() {
  if (!_editDispCtx) return;
  const v = document.getElementById('editDispNameInput').value.trim();
  if (!v) { toast('Bitte Namen eingeben', 'warning'); return; }
  const d = dayData(_editDispCtx.nl, _editDispCtx.dsKey);
  const t = d[_editDispCtx.status].find(x => x.id === _editDispCtx.id);
  if (t) { t.name = v; t.updated = Date.now(); scheduleSave(); render(); }
  closeModal('editDispModal');
}
function confirmDeleteDisp() {
  if (!_editDispCtx) return;
  removeTour(_editDispCtx.nl, _editDispCtx.dsKey, _editDispCtx.status, _editDispCtx.id);
  closeModal('editDispModal');
}

// ╔═══════════════════════════════════════════════════════╗
// ║  IMPORT ENGINE                                        ║
// ╚═══════════════════════════════════════════════════════╝
const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function openImportModal() {
  const sel = document.getElementById('importNlSelect');
  if (sel) {
    sel.innerHTML = '';
    state.niederlassungen.forEach(nl => {
      const opt = document.createElement('option');
      opt.value = nl; opt.textContent = nl;
      if (nl === activeNL) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  document.getElementById('importTextarea').value = '';
  document.getElementById('importPreviewInfo').textContent = '—';
  openModal('importModal');
}

/** Parse raw text → [{dateObj, dsKey, city}] */
function parseImportText(rawText) {
  const entries = [];
  const lines = rawText.split('\n');
  lines.forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(';').map(p => p.trim()).filter(Boolean);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const dateStr = parts[i];
      const city = parts[i + 1];
      if (!dateStr || !city) continue;
      const m = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (!m) continue;
      const dateObj = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
      if (isNaN(dateObj.getTime())) continue;
      entries.push({ dateObj, dsKey: ds(dateObj), city });
    }
  });
  return entries;
}

function updateImportPreview() {
  const raw = document.getElementById('importTextarea').value;
  const items = parseImportText(raw);
  const info = document.getElementById('importPreviewInfo');
  if (!info) return;
  if (items.length === 0) {
    info.textContent = raw.trim() ? '⚠ Keine gültigen Einträge gefunden' : '—';
    info.style.color = raw.trim() ? 'var(--warning)' : 'var(--text-4)';
  } else {
    const days = new Set(items.map(e => e.dsKey)).size;
    info.textContent = `✓ ${items.length} Tour${items.length !== 1 ? 'en' : ''} auf ${days} Tag${days !== 1 ? 'en' : ''} erkannt`;
    info.style.color = 'var(--success)';
  }
  return items;
}

function pickImportFile() {
  document.getElementById('importFileInput').click();
}

function loadImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('importTextarea').value = e.target.result;
    updateImportPreview();
  };
  reader.readAsText(file, 'utf-8');
  event.target.value = ''; // reset
}

function executeImport() {
  const raw = document.getElementById('importTextarea').value;
  const nl = document.getElementById('importNlSelect').value || activeNL;
  const items = parseImportText(raw);

  if (!items.length) {
    toast('Keine gültigen Einträge zum Importieren', 'warning');
    return;
  }

  items.forEach(e => {
    dayData(nl, e.dsKey).pending.push({
      id: uid(), name: e.city.trim(),
      created: e.dateObj.getTime(), updated: e.dateObj.getTime()
    });
  });

  // Auto-navigate the view to the week of the most newly imported date
  const maxTime = Math.max(...items.map(x => x.dateObj.getTime()));
  const thisMon = getMonday(0).getTime();
  weekOffset = Math.floor((maxTime - thisMon) / (7 * 86400000));

  scheduleSave();
  render();
  closeModal('importModal');
  toast(`${items.length} Touren importiert ✓`, 'success');
  showImportStats(items, nl);
}

function showImportStats(items, nl) {
  const byMonth = {};
  const byCity = {};
  const byWeekday = Array(7).fill(0);
  const WDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  items.forEach(e => {
    const key = e.dateObj.getFullYear() + '-' + String(e.dateObj.getMonth()).padStart(2, '0');
    byMonth[key] = (byMonth[key] || 0) + 1;
    const cLow = e.city.trim();
    byCity[cLow] = (byCity[cLow] || 0) + 1;
    const wd = (e.dateObj.getDay() + 6) % 7;
    byWeekday[wd]++;
  });

  const maxMonth = Math.max(...Object.values(byMonth));
  const maxWeekday = Math.max(...byWeekday);

  const monthsSorted = Object.keys(byMonth).sort();
  const topCities = Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxCity = topCities[0] ? topCities[0][1] : 1;

  const monthRows = monthsSorted.map(key => {
    const [y, m] = key.split('-');
    const count = byMonth[key];
    const pct = Math.round(count / maxMonth * 100);
    return `<div class="stat-row-item">
      <div class="stat-row-label">${MONTHS_DE[parseInt(m)]} ${y}</div>
      <div class="stat-bar-wrap"><div class="stat-bar" style="width:${pct}%"></div></div>
      <div class="stat-row-val">${count}</div>
    </div>`;
  }).join('');

  const cityRows = topCities.map(([city, count]) => {
    const pct = Math.round(count / maxCity * 100);
    return `<div class="stat-row-item">
      <div class="stat-row-label">${escHtml(city)}</div>
      <div class="stat-bar-wrap"><div class="stat-bar stat-bar-city" style="width:${pct}%"></div></div>
      <div class="stat-row-val">${count}</div>
    </div>`;
  }).join('');

  const wdayBars = WDAYS.map((d, i) => {
    const count = byWeekday[i];
    const pct = maxWeekday > 0 ? Math.round(count / maxWeekday * 100) : 0;
    return `<div class="stat-wday-col">
      <div class="stat-wday-bar-wrap">
        <div class="stat-wday-bar" style="height:${pct}%"></div>
      </div>
      <div class="stat-wday-label">${d}</div>
      <div class="stat-wday-val">${count}</div>
    </div>`;
  }).join('');

  const uniqueDays = new Set(items.map(e => e.dsKey)).size;
  const uniqueCities = Object.keys(byCity).length;

  document.getElementById('importStatsBody').innerHTML = `
    <div class="stats-summary-pills">
      <div class="stats-summary-pill">
        <div class="stats-pill-val">${items.length}</div>
        <div class="stats-pill-lbl">Touren</div>
      </div>
      <div class="stats-summary-pill">
        <div class="stats-pill-val">${uniqueDays}</div>
        <div class="stats-pill-lbl">Fahrtage</div>
      </div>
      <div class="stats-summary-pill">
        <div class="stats-pill-val">${uniqueCities}</div>
        <div class="stats-pill-lbl">Zielorte</div>
      </div>
      <div class="stats-summary-pill" style="flex:100%;text-align:center">
        <div class="stats-pill-val" style="font-size:1.1rem">${nl}</div>
        <div class="stats-pill-lbl">Importiert nach</div>
      </div>
    </div>

    <div class="stats-section-title">Wochentage</div>
    <div class="stat-wday-row">${wdayBars}</div>

    <div class="stats-section-title">Letzte Monate</div>
    <div class="stat-rows">${monthRows || '<div class="stat-empty">–</div>'}</div>

    <div class="stats-section-title">Top ${topCities.length} Ziele</div>
    <div class="stat-rows">${cityRows || '<div class="stat-empty">–</div>'}</div>
  `;

  openModal('importStatsModal');
}
