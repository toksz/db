'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let db = null;
let fileHandle = null;
let currentNL = null;
let currentWeekStart = null;
let saveTimer = null;
let lastSavedVersion = null;
let isDark = false;
let searchQuery = '';
let activeFilters = { fahrer: '', fahrzeug: '', farbe: '', status: '' };
let editingTourId = null;
let dragId = null;
let collapsedSections = new Set();
let filterPanelOpen = false;
let currentViewMode = 'week'; // 'today' | 'week' | 'month'
let statsVisible = true;

// ─── Color System ─────────────────────────────────────────────────────────────
const TOUR_COLORS = [
  { id: 'rot', label: 'Express', hex: '#ef4444', light: '#fef2f2', border: '#fca5a5' },
  { id: 'blau', label: 'Kühlware', hex: '#3b82f6', light: '#eff6ff', border: '#93c5fd' },
  { id: 'gruen', label: 'Stammkunde', hex: '#16a34a', light: '#f0fdf4', border: '#86efac' },
  { id: 'gelb', label: 'Achtung', hex: '#f59e0b', light: '#fffbeb', border: '#fcd34d' },
  { id: 'lila', label: 'Sondertransport', hex: '#8b5cf6', light: '#f5f3ff', border: '#c4b5fd' },
  { id: 'grau', label: 'Standard', hex: '#6b7280', light: '#f9fafb', border: '#d1d5db' },
];
function getColor(id) { return TOUR_COLORS.find(c => c.id === id) || null; }

// ─── Utilities ────────────────────────────────────────────────────────────────
function uid() { return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }
function fmt(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function parseDate(str) { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d); }
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - (day === 0 ? 6 : day - 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function fmtShort(dateStr) { const [, m, d] = dateStr.split('-'); return `${d}.${m}.`; }
function fmtDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}`;
}
function fmtTime(dtStr) {
  if (!dtStr) return null;
  const t = dtStr.slice(11, 16);
  return t && t !== '00:00' ? t : null;
}
function fmtPrice(val) {
  if (!val && val !== 0) return '—';
  return Number(val).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}
function fmtWeight(val) {
  if (!val && val !== 0) return '—';
  return `${Number(val).toLocaleString('de-DE')} kg`;
}
function fmtDateTimeLocal(str) { return str ? str.slice(0, 16) : ''; }
function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - y) / 86400000) + 1) / 7);
}
function initials(name) {
  if (!name) return '';
  return name.trim().split(/\s+/).map(p => p[0].toUpperCase()).slice(0, 2).join('');
}
const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

// ─── Address Book ─────────────────────────────────────────────────────────────
function collectAddressBook() {
  const sets = { adressen: new Set(), fahrer: new Set(), fahrzeug: new Set(), frachtfuehrer: new Set() };

  // From History
  for (const nlKey of Object.keys(db.tours || {})) {
    for (const day of Object.values(db.tours[nlKey] || {})) {
      for (const t of [...(day.pending || []), ...(day.done || [])]) {
        if (t.absender) sets.adressen.add(t.absender);
        if (t.empfaenger) sets.adressen.add(t.empfaenger);
        if (t.startort) sets.adressen.add(t.startort);
        if (t.fahrer) sets.fahrer.add(t.fahrer);
        if (t.fahrzeug) sets.fahrzeug.add(t.fahrzeug);
        if (t.frachtfuehrer) sets.frachtfuehrer.add(t.frachtfuehrer);
      }
    }
  }

  // From Stammdaten (highest priority autocomplete)
  if (db.stammdaten) {
    db.stammdaten.fahrer?.forEach(f => sets.fahrer.add(f.name));
    db.stammdaten.fahrzeuge?.forEach(f => sets.fahrzeug.add(f.kz));
    db.stammdaten.adressen?.forEach(a => {
      const full = a.name + (a.ort ? ', ' + a.ort : '');
      sets.adressen.add(full);
    });
    db.stammdaten.frachtfuehrer?.forEach(f => sets.frachtfuehrer.add(f.firma));
  }

  return {
    adressen: [...sets.adressen],
    fahrer: [...sets.fahrer],
    fahrzeug: [...sets.fahrzeug],
    frachtfuehrer: [...sets.frachtfuehrer]
  };
}
function rebuildDatalist(id, items) {
  let dl = document.getElementById(id);
  if (!dl) { dl = document.createElement('datalist'); dl.id = id; document.body.appendChild(dl); }
  dl.innerHTML = items.map(v => `<option value="${escHtml(v)}">`).join('');
}

// ─── File Handling ─────────────────────────────────────────────────────────────────
// IndexedDB helpers for persisting the FileSystemFileHandle across page reloads
const IDB_NAME = 'dispobook', IDB_STORE = 'handles', IDB_KEY = 'lastFileHandle';
const HANDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
function openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}
async function saveHandleToIDB(handle) {
  try {
    const db_ = await openIDB();
    const tx = db_.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ handle, savedAt: Date.now() }, IDB_KEY);
  } catch (_) { }
}
async function loadHandleFromIDB() {
  try {
    const db_ = await openIDB();
    return new Promise((res) => {
      const tx = db_.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = e => {
        const r = e.target.result;
        if (r && (Date.now() - r.savedAt) < HANDLE_TTL_MS) res(r.handle);
        else res(null);
      };
      req.onerror = () => res(null);
    });
  } catch (_) { return null; }
}
async function clearHandleFromIDB() {
  try {
    const db_ = await openIDB();
    const tx = db_.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
  } catch (_) { }
}
async function pickFile() {
  try {
    [fileHandle] = await window.showOpenFilePicker({ id: 'dispobook_data', types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
    const file = await fileHandle.getFile();
    db = JSON.parse(await file.text());
    lastSavedVersion = db.version;
    await saveHandleToIDB(fileHandle);
    initApp();
  } catch (e) { if (e.name !== 'AbortError') toast('Fehler beim Öffnen: ' + e.message, 'error'); }
}
async function createNewFile() {
  try {
    fileHandle = await window.showSaveFilePicker({ id: 'dispobook_data', suggestedName: 'data.json', types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
    db = { version: Date.now(), niederlassungen: ['Haupt'], tours: { 'Haupt': {} }, deletedTours: {}, stammdaten: { fahrer: [], fahrzeuge: [], frachtfuehrer: [], adressen: [] } };
    await saveHandleToIDB(fileHandle);
    await saveFile(); lastSavedVersion = db.version; initApp();
  } catch (e) { if (e.name !== 'AbortError') toast('Fehler beim Erstellen: ' + e.message, 'error'); }
}
// Try to restore a previously used file handle on page load
async function tryRestoreHandle() {
  const handle = await loadHandleFromIDB();
  if (!handle) return;
  try {
    // Re-request permission without a user gesture — works in Chrome if still granted
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      fileHandle = handle;
      const file = await fileHandle.getFile();
      db = JSON.parse(await file.text());
      lastSavedVersion = db.version;
      initApp();
      return;
    }
    // Permission not automatically granted — show a minimal "Resume" button
    showResumeButton(handle);
  } catch (_) { clearHandleFromIDB(); }
}
function showResumeButton(handle) {
  const box = document.getElementById('file-setup-box') || document.querySelector('.file-setup-box');
  if (!box) return;
  const btn = document.createElement('button');
  btn.className = 'file-setup-btn primary';
  btn.style.marginTop = '12px';
  btn.innerHTML = `▶ Zuletzt geöffnete Datei fortsetzen`;
  btn.onclick = async () => {
    try {
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        fileHandle = handle;
        const file = await fileHandle.getFile();
        db = JSON.parse(await file.text());
        lastSavedVersion = db.version;
        await saveHandleToIDB(fileHandle);
        initApp();
      }
    } catch (_) { }
  };
  box.appendChild(btn);
}
async function saveFile() {
  if (!fileHandle) return;
  db.version = Date.now(); setSyncStatus('saving');
  try {
    const w = await fileHandle.createWritable();

    // OPTIMIZE JSON: recursive cleanup to remove empty days
    const cleanData = JSON.parse(JSON.stringify(db));
    if (cleanData.tours) {
      for (const nl in cleanData.tours) {
        for (const date in cleanData.tours[nl]) {
          const day = cleanData.tours[nl][date];
          if ((!day.pending || day.pending.length === 0) && (!day.done || day.done.length === 0)) {
            delete cleanData.tours[nl][date];
          }
        }
      }
    }

    await w.write(JSON.stringify(cleanData, null, 2)); await w.close();
    lastSavedVersion = db.version; setSyncStatus('saved');
  } catch { setSyncStatus('error'); toast('Fehler beim Speichern!', 'error'); }
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveFile, 100); }
async function pollFile() {
  if (!fileHandle) return;
  try {
    const file = await fileHandle.getFile();
    const remote = JSON.parse(await file.text());
    if (remote.version !== lastSavedVersion && remote.version !== db.version)
      document.getElementById('conflictBanner').classList.add('visible');
  } catch (_) { }
}
function setSyncStatus(state) {
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  const badge = document.getElementById('syncBadge');
  dot.className = 'sync-dot' + (state === 'saving' ? ' saving' : state === 'error' ? ' error' : '');
  if (state === 'saving') { label.textContent = 'Speichert…'; badge.classList.remove('visible'); }
  else if (state === 'saved') {
    const n = new Date();
    label.textContent = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
    badge.classList.add('visible'); setTimeout(() => badge.classList.remove('visible'), 2500);
  } else { label.textContent = 'Fehler'; }
}

// ─── App Init ─────────────────────────────────────────────────────────────────
function initApp() {
  document.getElementById('fileSetup').style.display = 'none';
  document.getElementById('app').style.display = '';
  currentNL = db.niederlassungen[0] || 'Haupt';
  currentWeekStart = getMonday(new Date());
  isDark = localStorage.getItem('darkMode') === '1';
  if (isDark) document.documentElement.classList.add('dark-mode');
  if (!db.stammdaten) db.stammdaten = { fahrer: [], fahrzeuge: [], frachtfuehrer: [], adressen: [] }; // Format migration
  updateThemeUI(); render();
  setInterval(pollFile, 8000);
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() { renderNLSwitcher(); renderWeekLabel(); renderStats(); renderViewModeSelector(); renderGrid(); renderStagingTray(); updateFilterBadge(); }

// ─── NL Switcher ─────────────────────────────────────────────────────────────
function renderNLSwitcher() {
  const nameEl = document.getElementById('nlSwitcherName');
  const prevBtn = document.getElementById('nlSwitcherPrev');
  const nextBtn = document.getElementById('nlSwitcherNext');
  if (!nameEl) return;
  const nls = db.niederlassungen || [];
  const idx = nls.indexOf(currentNL);
  nameEl.textContent = currentNL;
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx >= nls.length - 1;
  const tours = db.tours[currentNL] || {};
  let total = 0;
  for (const day of Object.values(tours)) total += (day.pending || []).length + (day.done || []).length;
  const badge = document.getElementById('nlSwitcherCount');
  if (badge) { badge.textContent = total; badge.style.display = total > 0 ? '' : 'none'; }
}
function switchNL(dir) {
  const nls = db.niederlassungen || [];
  const idx = nls.indexOf(currentNL);
  const ni = idx + dir;
  if (ni >= 0 && ni < nls.length) { currentNL = nls[ni]; render(); }
}

// ─── Week Nav ─────────────────────────────────────────────────────────────────
function renderWeekLabel() {
  const lbl = document.getElementById('weekLabel');
  if (!lbl) return;
  if (currentViewMode === 'today') {
    const today = new Date();
    lbl.textContent = `${DAY_NAMES[(today.getDay() + 6) % 7]}, ${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;
  } else if (currentViewMode === 'month') {
    const months = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    lbl.textContent = `${months[currentWeekStart.getMonth()]} ${currentWeekStart.getFullYear()}`;
  } else {
    const end = addDays(currentWeekStart, 6);
    const kw = getISOWeek(currentWeekStart);
    const s = d => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
    lbl.textContent = `KW ${kw} · ${s(currentWeekStart)} – ${s(end)}`;
  }
}
function changeWeek(dir) {
  if (currentViewMode === 'month') {
    // Navigate by month
    const d = new Date(currentWeekStart);
    d.setMonth(d.getMonth() + dir);
    currentWeekStart = d;
  } else {
    currentWeekStart = addDays(currentWeekStart, dir * 7);
  }
  render();
}
function goToday() { currentWeekStart = getMonday(new Date()); render(); }
function setViewMode(mode) {
  currentViewMode = mode;
  if (mode === 'today') { currentWeekStart = getMonday(new Date()); }
  render();
}
function renderViewModeSelector() {
  const btns = document.querySelectorAll('.view-mode-btn');
  btns.forEach(b => b.classList.toggle('active', b.dataset.mode === currentViewMode));
  // Show/hide prev/next arrows in today/month mode
  const prevBtn = document.getElementById('weekNavPrev');
  const nextBtn = document.getElementById('weekNavNext');
  if (prevBtn) prevBtn.style.display = currentViewMode === 'today' ? 'none' : '';
  if (nextBtn) nextBtn.style.display = currentViewMode === 'today' ? 'none' : '';
}
function toggleStatsRow() {
  statsVisible = !statsVisible;
  const row = document.getElementById('statsRow');
  if (row) row.style.display = statsVisible ? '' : 'none';
  const btn = document.getElementById('statsToggleBtn');
  if (btn) btn.title = statsVisible ? 'Statistiken ausblenden' : 'Statistiken einblenden';
}
function openUnifiedImportModal() {
  openModal('unifiedImportModal');
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function renderStats() {
  const row = document.getElementById('statsRow');
  if (!row) return;
  const tours = db.tours[currentNL] || {};
  let pending = 0, done = 0, totalWeight = 0, totalPrice = 0, overdue = 0;
  const today = fmt(new Date());
  for (const day of Object.values(tours)) {
    pending += (day.pending || []).length;
    done += (day.done || []).length;
    for (const t of [...(day.pending || []), ...(day.done || [])]) {
      if (t.gewicht) totalWeight += Number(t.gewicht);
      if (t.frachtpreis) totalPrice += Number(t.frachtpreis);
      if (t.liefertermin && t.liefertermin.slice(0, 10) < today && !t.verladen_am) overdue++;
    }
  }
  const total = pending + done;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  row.innerHTML = `
    <div class="stat-pill"><span class="stat-pip" style="background:var(--amber-bdr)"></span>Ausstehend <strong>${pending}</strong></div>
    <div class="stat-pill"><span class="stat-pip" style="background:var(--green-bdr)"></span>Disponiert <strong>${done}</strong></div>
    <div class="stat-pill">Gesamt <strong>${total}</strong></div>
    <div class="stat-pill">
      <div class="stat-progress-wrap"><div class="stat-progress-bar" style="width:${pct}%"></div></div>
      Fortschritt <strong>${pct}%</strong>
    </div>
    ${totalWeight > 0 ? `<div class="stat-pill">⚖ <strong>${fmtWeight(totalWeight)}</strong></div>` : ''}
    ${totalPrice > 0 ? `<div class="stat-pill">💶 <strong>${fmtPrice(totalPrice)}</strong></div>` : ''}
    ${overdue > 0 ? `<div class="stat-pill stat-pill-danger">⚠ Überfällig <strong>${overdue}</strong></div>` : ''}
  `;
}

// ─── Filter Panel ─────────────────────────────────────────────────────────────
function toggleFilterPanel() {
  filterPanelOpen = !filterPanelOpen;
  document.getElementById('filterPanel').classList.toggle('open', filterPanelOpen);
  document.getElementById('filterBtn').classList.toggle('active', filterPanelOpen);
  if (filterPanelOpen) populateFilterOptions();
}
function populateFilterOptions() {
  const book = collectAddressBook();
  const makeOpts = (arr, val) => `<option value="">Alle</option>` + arr.map(v => `<option${v === val ? ' selected' : ''}>${escHtml(v)}</option>`).join('');
  document.getElementById('filterFahrer').innerHTML = makeOpts(book.fahrer, activeFilters.fahrer);
  document.getElementById('filterFahrzeug').innerHTML = makeOpts(book.fahrzeug, activeFilters.fahrzeug);
  document.getElementById('filterStatus').value = activeFilters.status;
  const colorWrap = document.getElementById('filterFarbe');
  colorWrap.innerHTML = [{ id: '', label: 'Alle', hex: '#9ca3af' }, ...TOUR_COLORS].map(c =>
    `<button type="button" class="filter-color-pill ${activeFilters.farbe === c.id ? 'active' : ''}"
      style="--c:${c.hex}" onclick="setFilterFarbe('${c.id}')" title="${c.label}">
      <span class="fcp-dot"></span>${c.label}
    </button>`).join('');
}
function setFilterFarbe(id) { activeFilters.farbe = id; populateFilterOptions(); renderGrid(); updateFilterBadge(); }
function applyFilterInputs() {
  activeFilters.fahrer = document.getElementById('filterFahrer').value;
  activeFilters.fahrzeug = document.getElementById('filterFahrzeug').value;
  activeFilters.status = document.getElementById('filterStatus').value;
  renderGrid(); updateFilterBadge();
}
function resetFilters() {
  activeFilters = { fahrer: '', fahrzeug: '', farbe: '', status: '' };
  searchQuery = ''; document.getElementById('searchInput').value = '';
  populateFilterOptions(); renderGrid(); updateFilterBadge();
}
function updateFilterBadge() {
  const count = Object.values(activeFilters).filter(v => v !== '').length + (searchQuery ? 1 : 0);
  const badge = document.getElementById('filterBadge');
  if (badge) { badge.textContent = count; badge.style.display = count > 0 ? '' : 'none'; }
}
function matchesFilters(t) {
  const q = searchQuery.toLowerCase();
  if (q && ![t.name, t.empfaenger, t.absender, t.kommissionierliste, t.fahrer, t.fahrzeug]
    .some(v => (v || '').toLowerCase().includes(q))) return false;
  if (activeFilters.fahrer && t.fahrer !== activeFilters.fahrer) return false;
  if (activeFilters.fahrzeug && t.fahrzeug !== activeFilters.fahrzeug) return false;
  if (activeFilters.farbe && t.farbe !== activeFilters.farbe) return false;
  return true;
}

// ─── Grid ─────────────────────────────────────────────────────────────────────
function renderGrid() {
  const grid = document.getElementById('daysGrid');
  const today = fmt(new Date());
  const tours = db.tours[currentNL] || {};

  // Build list of date keys to display
  let dateKeys = [];
  if (currentViewMode === 'today') {
    dateKeys = [today];
  } else if (currentViewMode === 'month') {
    const firstDay = new Date(currentWeekStart.getFullYear(), currentWeekStart.getMonth(), 1);
    const lastDay = new Date(currentWeekStart.getFullYear(), currentWeekStart.getMonth() + 1, 0);
    for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
      dateKeys.push(fmt(new Date(d)));
    }
  } else {
    for (let i = 0; i < 7; i++) dateKeys.push(fmt(addDays(currentWeekStart, i)));
  }

  const daySelect = document.getElementById('addTourDaySelect');
  if (daySelect) {
    const prev = daySelect.value;
    daySelect.innerHTML = '';
    dateKeys.forEach(key => {
      const d = parseDate(key);
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `${DAY_NAMES[(d.getDay() + 6) % 7].slice(0, 2)} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
      daySelect.appendChild(opt);
    });
    if (prev && daySelect.querySelector(`option[value="${prev}"]`)) daySelect.value = prev;
    else if (daySelect.querySelector(`option[value="${today}"]`)) daySelect.value = today;
  }

  grid.innerHTML = '';
  // Month view: use smaller columns
  grid.style.gridTemplateColumns = currentViewMode === 'month'
    ? 'repeat(auto-fill, minmax(160px, 1fr))'
    : currentViewMode === 'today' ? '1fr' : '';

  dateKeys.forEach(key => {
    const d = parseDate(key);
    const i = (d.getDay() + 6) % 7; // 0=Mon
    const dayData = tours[key] || { pending: [], done: [] };
    const isToday = key === today;

    const pendingAll = dayData.pending || [];
    const doneAll = dayData.done || [];
    const pending = pendingAll.filter(t => matchesFilters(t) && (!activeFilters.status || activeFilters.status === 'pending'));
    const done = doneAll.filter(t => matchesFilters(t) && (!activeFilters.status || activeFilters.status === 'done'));

    const pendingKey = `pending-${key}`;
    const doneKey = `done-${key}`;
    const pc = collapsedSections.has(pendingKey);
    const dc = collapsedSections.has(doneKey);

    const col = document.createElement('div');
    col.className = 'day-col' + (isToday ? ' today' : key < today ? ' past' : '');
    col.dataset.date = key;

    col.innerHTML = `
      <div class="day-head">
        <div class="day-name-wrap">
          <div class="day-name">${DAY_NAMES[i]}${isToday ? ' <span class="today-badge">HEUTE</span>' : ''}</div>
          <div class="day-date">${fmtShort(key)}</div>
        </div>
        <div class="day-total">${pendingAll.length + doneAll.length}</div>
      </div>
      <div class="section section-pending">
        <div class="section-head" onclick="toggleSection('${pendingKey}')">
          <span class="section-title">Ausstehend</span>
          <div class="section-head-right">
            <span class="section-count">${pendingAll.length}</span>
            <span class="section-chevron ${pc ? 'collapsed' : ''}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg></span>
          </div>
        </div>
        <div class="drop-zone ${pc ? 'section-hidden' : ''}" id="pending-${key}" data-date="${key}" data-status="pending">
          ${pending.length === 0
        ? `<div class="drop-empty">${pendingAll.length === 0 ? 'Keine ausstehenden Touren' : 'Kein Treffer'}</div>`
        : pending.map(t => renderTourCard(t, false, key)).join('')}
        </div>
      </div>
      <div class="section section-done">
        <div class="section-head" onclick="toggleSection('${doneKey}')">
          <span class="section-title">Disponiert</span>
          <div class="section-head-right">
            <span class="section-count">${doneAll.length}</span>
            <span class="section-chevron ${dc ? 'collapsed' : ''}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg></span>
          </div>
        </div>
        <div class="drop-zone ${dc ? 'section-hidden' : ''}" id="done-${key}" data-date="${key}" data-status="done">
          ${done.length === 0
        ? `<div class="drop-empty">${doneAll.length === 0 ? 'Noch keine disponierten Touren' : 'Kein Treffer'}</div>`
        : done.map(t => renderTourCard(t, true, key)).join('')}
        </div>
      </div>`;
    grid.appendChild(col);
  });
  setupDragDrop();
  setupCardEvents();
  rebuildAutocomplete();
}

// ─── Tour Card ────────────────────────────────────────────────────────────────
function renderTourCard(t, isDone, dateKey) {
  const color = getColor(t.farbe);
  const colorStyle = color ? `style="border-left-color:${color.hex}"` : '';
  const today = fmt(new Date());
  const liefDate = t.liefertermin ? t.liefertermin.slice(0, 10) : null;
  const isOverdue = liefDate && liefDate < today && !isDone;
  const isToday = liefDate === today && !isDone;
  const ladezeit = fmtTime(t.ladebereit_ab);

  const chips = [];
  if (ladezeit) chips.push(`<span class="tc-chip tc-chip-time">🕐 ${escHtml(ladezeit)}</span>`);
  if (t.fahrer) chips.push(`<span class="tc-chip tc-chip-driver" title="${escHtml(t.fahrer)}">${escHtml(initials(t.fahrer))}</span>`);
  if (t.fahrzeug) chips.push(`<span class="tc-chip tc-chip-vehicle" title="${escHtml(t.fahrzeug)}">🚛 ${escHtml(t.fahrzeug)}</span>`);
  if (t.gewicht) chips.push(`<span class="tc-chip">⚖ ${fmtWeight(t.gewicht)}</span>`);
  if (liefDate) {
    const cls = isOverdue ? 'tc-chip-danger' : isToday ? 'tc-chip-warn' : '';
    chips.push(`<span class="tc-chip ${cls}" title="Liefertermin">${isOverdue ? '🔴' : '📅'} ${escHtml(liefDate.slice(5).replace('-', '.'))}</span>`);
  }
  if (t.besonderheiten) chips.push(`<span class="tc-chip tc-chip-warn" title="${escHtml(t.besonderheiten)}">⚠</span>`);

  const expItems = [];
  if (t.startort) expItems.push(`<div><strong>Start:</strong> ${escHtml(t.startort)}</div>`);
  if (t.empfaenger) expItems.push(`<div><strong>Ziel:</strong> ${escHtml(t.empfaenger)}</div>`);
  if (t.empf_zeitfenster) expItems.push(`<div><strong>Zeit:</strong> ${escHtml(t.empf_zeitfenster)}</div>`);
  if (t.tourtyp) expItems.push(`<div><strong>Typ:</strong> ${escHtml(t.tourtyp)}</div>`);
  if (t.referenznummer) expItems.push(`<div><strong>Ref:</strong> ${escHtml(t.referenznummer)}</div>`);
  if (t.transportnummer) expItems.push(`<div><strong>TR:</strong> ${escHtml(t.transportnummer)}</div>`);
  if (t.lademeter) expItems.push(`<div><strong>LDM:</strong> ${t.lademeter}</div>`);
  if (t.fahrer || t.fahrzeug) expItems.push(`<div><strong>Fahrer/Fzg:</strong> ${escHtml(t.fahrer || '')} ${escHtml(t.fahrzeug || '')}</div>`);
  if (t.attachments && t.attachments.length) expItems.push(`<div>📎 ${t.attachments.length} Anhang</div>`);

  const hasExp = expItems.length > 0;
  const isExpanded = _expandedCards.has(t.id);

  return `<div class="tour-card ${isDone ? 'done' : ''} ${color ? 'tour-card-colored' : ''} ${isExpanded ? 'expanded' : ''}" draggable="true" data-id="${t.id}" ${colorStyle}>
    <span class="tour-drag-handle">⠿</span>
    <div class="tour-card-body">
      <div class="tour-name-row">
        <span class="tour-name">${escHtml(t.name)}</span>
        ${color ? `<span class="tour-color-dot" style="background:${color.hex}" title="${color.label}"></span>` : ''}
      </div>
      ${t.empfaenger ? `<div class="tour-empfaenger">📦 ${escHtml(t.empfaenger)}</div>` : ''}
      ${chips.length ? `<div class="tour-chips">${chips.join('')}</div>` : ''}
      ${hasExp ? `<div class="tour-expanded-content" style="display:${isExpanded ? 'grid' : 'none'}">${expItems.join('')}</div>` : ''}
    </div>
    <div class="tour-btns">
      ${hasExp ? `<button class="tour-btn expand" data-id="${t.id}" title="Details ein-/ausblenden" aria-label="Details ein-/ausblenden">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="${isExpanded ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}"/></svg>
      </button>` : ''}
      <button class="tour-btn toggle" data-id="${t.id}" title="${isDone ? 'Zurücksetzen' : 'Als disponiert markieren'}" aria-label="${isDone ? 'Zurücksetzen' : 'Als disponiert markieren'}">
        ${isDone
      ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`}
      </button>
      <button class="tour-btn detail" data-id="${t.id}" title="Bearbeiten" aria-label="Bearbeiten">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="tour-btn del" data-id="${t.id}" title="Löschen" aria-label="Tour löschen">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  </div>`;
}

// ─── Collapsible ──────────────────────────────────────────────────────────────
function toggleSection(key) {
  if (collapsedSections.has(key)) collapsedSections.delete(key);
  else collapsedSections.add(key);
  renderGrid();
}

// ─── Card Events ──────────────────────────────────────────────────────────────
let _expandedCards = new Set();
function setupCardEvents() {
  document.querySelectorAll('.tour-btn.expand').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (_expandedCards.has(id)) _expandedCards.delete(id);
      else _expandedCards.add(id);
      renderGrid(); // Quick re-render to update expand state
    }));
  document.querySelectorAll('.tour-btn.toggle').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); toggleTourStatus(btn.dataset.id); }));
  document.querySelectorAll('.tour-btn.del').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); openConfirmDelete(btn.dataset.id); }));
  document.querySelectorAll('.tour-btn.detail').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); openTourDetail(btn.dataset.id); }));
  // Right-click context menu (full options)
  document.querySelectorAll('.tour-card').forEach(card =>
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(card.dataset.id, e.clientX, e.clientY, true);
    }));
  // Left-click context menu (basic options only)
  document.querySelectorAll('.tour-card').forEach(card =>
    card.addEventListener('click', e => {
      if (!e.target.closest('.tour-btns') && !e.target.closest('.tour-drag-handle')) {
        e.preventDefault();
        e.stopPropagation();
        openCtxMenu(card.dataset.id, e.clientX, e.clientY, false);
      }
    }));
  document.querySelectorAll('.tour-card').forEach(card =>
    card.addEventListener('dblclick', e => {
      if (!e.target.closest('.tour-btns') && !e.target.closest('.tour-drag-handle') && !e.target.closest('.ctx-item'))
        openTourDetail(card.dataset.id);
    }));
}

// ─── Tour Helpers ─────────────────────────────────────────────────────────────
function findTour(id) {
  for (const [dateKey, day] of Object.entries(db.tours[currentNL] || {})) {
    for (const t of (day.pending || [])) if (t.id === id) return { tour: t, dateKey, status: 'pending' };
    for (const t of (day.done || [])) if (t.id === id) return { tour: t, dateKey, status: 'done' };
  }
  return null;
}
function toggleTourStatus(id) {
  const found = findTour(id);
  if (!found) return;
  const { tour, dateKey, status } = found;
  const day = db.tours[currentNL][dateKey];
  if (status === 'pending') {
    day.pending = day.pending.filter(t => t.id !== id);
    tour.verladen_am = fmtDateTime(new Date());
    day.done = [...(day.done || []), tour];
  } else {
    day.done = day.done.filter(t => t.id !== id);
    tour.verladen_am = null;
    day.pending = [...(day.pending || []), tour];
  }
  tour.updated = Date.now();
  scheduleSave(); render();
}
// ─── Confirm Delete ───────────────────────────────────────────────────────────
let _pendingDeleteId = null;
function openConfirmDelete(id) {
  _pendingDeleteId = id;
  openModal('confirmDeleteModal');
}
function confirmDeleteExecute() {
  if (!_pendingDeleteId) return;
  closeModal('confirmDeleteModal');
  deleteTour(_pendingDeleteId);
  _pendingDeleteId = null;
}

function deleteTour(id) {
  const found = findTour(id);
  if (!found) return;
  const { dateKey, status } = found;
  db.tours[currentNL][dateKey][status] = db.tours[currentNL][dateKey][status].filter(t => t.id !== id);
  db.deletedTours = db.deletedTours || {};
  db.deletedTours[id] = Date.now();
  scheduleSave(); render();
  toast('Tour gelöscht');
}

// ─── Staging Tray ─────────────────────────────────────────────────────────────
let stagingTours = []; // [{id, name}]
let _addPromptLastId = null;

function renderStagingTray() {
  const tray = document.getElementById('stagingTray');
  const row = document.getElementById('stagingRow');
  if (!tray || !row) return;
  if (stagingTours.length === 0) { tray.classList.remove('visible'); return; }
  tray.classList.add('visible');
  row.innerHTML = stagingTours.map(t => `
    <div class="staging-card" draggable="true" data-staging-id="${t.id}">
      <span class="staging-card-name">${escHtml(t.name)}</span>
      <span class="staging-card-drag-hint">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/><polyline points="12 5 19 12 12 19"/></svg>
        Ziehen
      </span>
      <button class="staging-card-remove" onclick="removeStagingTour('${t.id}')" title="Entfernen" aria-label="Aus Warteliste entfernen">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');
  // Setup drag from staging
  row.querySelectorAll('.staging-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      dragId = null;
      e.dataTransfer.setData('staging-id', card.dataset.stagingId);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.drop-zone').forEach(z => z.classList.remove('over', 'staging-over'));
      document.querySelectorAll('.day-col').forEach(c => c.classList.remove('drag-target'));
    });
  });
  // Staging drop onto zones
  document.querySelectorAll('.drop-zone:not(.section-hidden)').forEach(zone => {
    zone.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('staging-id')) return;
      e.preventDefault();
      zone.classList.add('staging-over');
      zone.closest('.day-col')?.classList.add('drag-target');
    });
    zone.addEventListener('dragleave', e => {
      if (!zone.contains(e.relatedTarget)) {
        zone.classList.remove('staging-over');
        zone.closest('.day-col')?.classList.remove('drag-target');
      }
    });
    zone.addEventListener('drop', e => {
      const sid = e.dataTransfer.getData('staging-id');
      if (!sid) return;
      e.preventDefault();
      zone.classList.remove('staging-over');
      zone.closest('.day-col')?.classList.remove('drag-target');
      dropStagingTour(sid, zone.dataset.date, zone.dataset.status);
    });
  });
}

function dropStagingTour(sid, dateKey, status) {
  const idx = stagingTours.findIndex(t => t.id === sid);
  if (idx === -1) return;
  const { id, name } = stagingTours[idx];
  stagingTours.splice(idx, 1);
  if (!db.tours[currentNL]) db.tours[currentNL] = {};
  if (!db.tours[currentNL][dateKey]) db.tours[currentNL][dateKey] = { pending: [], done: [] };
  const tour = { id, name, created: Date.now(), updated: Date.now() };
  db.tours[currentNL][dateKey][status || 'pending'].push(tour);
  scheduleSave(); render();
  const col = document.querySelector(`.day-col[data-date="${dateKey}"]`);
  if (col) { col.classList.add('remote-flash'); setTimeout(() => col.classList.remove('remote-flash'), 1400); }
  toast(`Tour „${name}" platziert`, 'success');
}

function removeStagingTour(id) {
  stagingTours = stagingTours.filter(t => t.id !== id);
  renderStagingTray();
}

// ─── Add Tour Bar ─────────────────────────────────────────────────────────────
function addTourFromBar() {
  const nameInput = document.getElementById('addTourName');
  const name = nameInput.value.trim();
  if (!name) { nameInput.classList.add('shake'); setTimeout(() => nameInput.classList.remove('shake'), 400); return; }
  const id = uid();
  stagingTours.push({ id, name });
  _addPromptLastId = id;
  nameInput.value = '';
  nameInput.focus();
  renderStagingTray();
  // Show prompt
  const promptName = document.getElementById('addPromptTourName');
  if (promptName) promptName.textContent = `„${name}"`;
  openModal('addPromptModal');
}
function addTourKeyDown(e) { if (e.key === 'Enter') addTourFromBar(); }
let editingStagingId = null;

function addPromptGoDetail() {
  closeModal('addPromptModal');
  if (!_addPromptLastId) return;
  const t = stagingTours.find(s => s.id === _addPromptLastId);
  if (!t) return;
  _addPromptLastId = null;
  editingStagingId = t.id;
  editingTourId = null;
  const map = {
    detailName: t.name, detailAbsender: '', detailEmpfaenger: '',
    detailFahrer: '', detailFahrzeug: '', detailFrachtfuehrer: '',
    detailKommissionierliste: '', detailGewicht: '',
    detailFrachtpreis: '', detailBesonderheiten: '',
    detailLiefertermin: '', detailLadebereit: '', detailVerladen: '',
    detailTransportnummer: '', detailTourtyp: '', detailStartort: '',
    detailEmpfAnsprechpartner: '', detailEmpfRampe: '', detailEmpfZeitfenster: '',
    detailReferenznummer: ''
  };
  for (const [fid, val] of Object.entries(map)) {
    const el = document.getElementById(fid);
    if (el) el.value = val;
  }
  document.getElementById('detailStatus').value = 'pending';
  renderColorPicker('');
  // Show date picker for staging - default to today
  const dateWrap = document.getElementById('detailDateWrap');
  const dateInp = document.getElementById('detailDate');
  if (dateWrap) dateWrap.style.display = '';
  if (dateInp) dateInp.value = fmt(new Date());

  const modalContent = document.querySelector('#tourDetailModal .modal-content-detail');
  if (modalContent) modalContent.classList.remove('split-active');
  const pdfSideKI = document.getElementById('pdfSideKI');
  if (pdfSideKI) pdfSideKI.style.display = 'none';
  const pdfIframeKI = document.getElementById('pdfIframeKI');
  if (pdfIframeKI) pdfIframeKI.src = '';

  openModal('tourDetailModal');
}

// ─── Tour Detail Modal ────────────────────────────────────────────────────────
function openTourDetail(id) {
  const found = findTour(id);
  if (!found) return;
  // openTourDetail: hide date picker (date is already fixed by placement)
  editingTourId = id;
  const { tour, status } = found;
  const map = {
    detailName: tour.name, detailAbsender: tour.absender, detailEmpfaenger: tour.empfaenger,
    detailFahrer: tour.fahrer, detailFahrzeug: tour.fahrzeug, detailFrachtfuehrer: tour.frachtfuehrer,
    detailKommissionierliste: tour.kommissionierliste, detailGewicht: tour.gewicht,
    detailFrachtpreis: tour.frachtpreis, detailBesonderheiten: tour.besonderheiten,
    detailTransportnummer: tour.transportnummer, detailTourtyp: tour.tourtyp, detailStartort: tour.startort,
    detailEmpfAnsprechpartner: tour.empf_ansprechpartner, detailEmpfRampe: tour.empf_rampe, detailEmpfZeitfenster: tour.empf_zeitfenster,
    detailReferenznummer: tour.referenznummer
  };
  for (const [fid, val] of Object.entries(map)) {
    const el = document.getElementById(fid);
    if (el) el.value = val || '';
  }
  // Hide date picker for existing tours
  const dateWrap = document.getElementById('detailDateWrap');
  if (dateWrap) dateWrap.style.display = 'none';
  const dtFields = { detailLiefertermin: tour.liefertermin, detailLadebereit: tour.ladebereit_ab, detailVerladen: tour.verladen_am };
  for (const [fid, val] of Object.entries(dtFields)) {
    const el = document.getElementById(fid);
    if (el) el.value = fmtDateTimeLocal(val);
  }
  document.getElementById('detailStatus').value = status;
  renderColorPicker(tour.farbe || '');

  // Render measurements
  document.getElementById('detailGewicht').value = tour.gewicht || '';
  document.getElementById('detailLademeter').value = tour.lademeter || '';
  document.getElementById('detailMassL').value = tour.massL || '';
  document.getElementById('detailMassB').value = tour.massB || '';
  document.getElementById('detailMassH').value = tour.massH || '';

  currentAttachments = JSON.parse(JSON.stringify(tour.attachments || []));
  renderAttachments();

  const modalContent = document.querySelector('#tourDetailModal .modal-content-detail');
  if (modalContent) modalContent.classList.remove('split-active');
  const pdfSideKI = document.getElementById('pdfSideKI');
  if (pdfSideKI) pdfSideKI.style.display = 'none';
  const pdfIframeKI = document.getElementById('pdfIframeKI');
  if (pdfIframeKI) pdfIframeKI.src = '';

  openModal('tourDetailModal');
}
function renderColorPicker(selected) {
  const wrap = document.getElementById('detailColorPicker');
  wrap.innerHTML = [{ id: '', label: 'Keine', hex: '#d1d5db' }, ...TOUR_COLORS].map(c =>
    `<button type="button" class="color-swatch ${selected === c.id ? 'selected' : ''}"
      style="background:${c.hex}" title="${c.label}" onclick="selectColor('${c.id}')"></button>`
  ).join('');
}
function selectColor(id) { renderColorPicker(id); _colorPickerValue = id; }
let _colorPickerValue = '';

function saveTourDetail() {
  if (!editingTourId && !editingStagingId) return;
  const found = editingTourId ? findTour(editingTourId) : null;
  if (editingTourId && !found) return;

  const nameEl = document.getElementById('detailName');
  const name = nameEl.value.trim();
  if (!name) {
    nameEl.classList.add('shake');
    nameEl.focus();
    setTimeout(() => nameEl.classList.remove('shake'), 400);
    return;
  }

  const tourObj = editingTourId ? found.tour : stagingTours.find(t => t.id === editingStagingId);
  if (!tourObj) return;

  tourObj.name = name;
  tourObj.absender = document.getElementById('detailAbsender').value.trim() || null;
  tourObj.empfaenger = document.getElementById('detailEmpfaenger').value.trim() || null;
  tourObj.fahrer = document.getElementById('detailFahrer').value.trim() || null;
  tourObj.fahrzeug = document.getElementById('detailFahrzeug').value.trim() || null;
  tourObj.frachtfuehrer = document.getElementById('detailFrachtfuehrer').value.trim() || null;
  tourObj.kommissionierliste = document.getElementById('detailKommissionierliste').value.trim() || null;
  tourObj.transportnummer = document.getElementById('detailTransportnummer').value.trim() || null;
  tourObj.tourtyp = document.getElementById('detailTourtyp').value || null;
  tourObj.startort = document.getElementById('detailStartort').value.trim() || null;
  tourObj.empf_ansprechpartner = document.getElementById('detailEmpfAnsprechpartner').value.trim() || null;
  tourObj.empf_rampe = document.getElementById('detailEmpfRampe').value.trim() || null;
  tourObj.empf_zeitfenster = document.getElementById('detailEmpfZeitfenster').value.trim() || null;
  tourObj.referenznummer = document.getElementById('detailReferenznummer').value.trim() || null;

  // Process Weights & Measurements
  const gewicht = parseInt(document.getElementById('detailGewicht').value);
  const lademeter = parseFloat(document.getElementById('detailLademeter').value);
  const massL = parseInt(document.getElementById('detailMassL').value);
  const massB = parseInt(document.getElementById('detailMassB').value);
  const massH = parseInt(document.getElementById('detailMassH').value);

  tourObj.gewicht = !isNaN(gewicht) ? gewicht : null;
  tourObj.lademeter = !isNaN(lademeter) ? lademeter : null;
  tourObj.massL = !isNaN(massL) ? massL : null;
  tourObj.massB = !isNaN(massB) ? massB : null;
  tourObj.massH = !isNaN(massH) ? massH : null;

  // Cleanup old position array if exists
  delete tourObj.positionen;  // Attachments
  tourObj.attachments = currentAttachments;

  // Manual frachtpreis & dates
  const p = parseFloat(document.getElementById('detailFrachtpreis')?.value);
  tourObj.frachtpreis = isNaN(p) ? null : p;
  tourObj.liefertermin = document.getElementById('detailLiefertermin')?.value || null;
  tourObj.ladebereit_ab = document.getElementById('detailLadebereit')?.value || null;
  tourObj.verladen_am = document.getElementById('detailVerladen')?.value || null;
  tourObj.besonderheiten = document.getElementById('detailBesonderheiten')?.value.trim() || null;

  const selectedSwatch = document.querySelector('#detailColorPicker .color-swatch.selected');
  tourObj.farbe = selectedSwatch ? selectedSwatch.getAttribute('title') !== 'Keine'
    ? TOUR_COLORS.find(c => c.hex === selectedSwatch.style.background || c.label === selectedSwatch.title)?.id || null
    : null : null;

  tourObj.updated = Date.now();

  if (editingTourId) {
    const { dateKey, status: oldStatus } = found;
    const newStatus = document.getElementById('detailStatus').value;
    if (newStatus !== oldStatus) {
      const day = db.tours[currentNL][dateKey];
      day[oldStatus] = day[oldStatus].filter(t => t.id !== tourObj.id);
      if (!day[newStatus]) day[newStatus] = [];
      if (newStatus === 'done' && !tourObj.verladen_am) tourObj.verladen_am = fmtDateTime(new Date());
      if (newStatus === 'pending') tourObj.verladen_am = null;
      day[newStatus].push(tourObj);
    }
  }

  editingStagingId = null;
  closeModal('tourDetailModal');
  // ─ If this was a KI staging tour, place it directly into db.tours ─
  if (!editingTourId) {
    const dateKey = document.getElementById('detailDate')?.value || fmt(new Date());
    if (!db.tours[currentNL]) db.tours[currentNL] = {};
    if (!db.tours[currentNL][dateKey]) db.tours[currentNL][dateKey] = { pending: [], done: [] };
    const status = document.getElementById('detailStatus')?.value || 'pending';
    db.tours[currentNL][dateKey][status].push(tourObj);
  }
  db.version = Date.now();
  scheduleSave(); render();
  toast('Tour gespeichert', 'success');
}
function deleteTourFromDetail() {
  if (!editingTourId) return;
  closeModal('tourDetailModal');
  openConfirmDelete(editingTourId);
  editingTourId = null;
}

// ─── Attachments (DMS) ────────────────────────────────────────────────────────
let currentAttachments = [];

function renderAttachments() {
  const c = document.getElementById('attachmentsContainer');
  if (!c) return;
  c.innerHTML = currentAttachments.map((att, idx) => `
    <div style="display:flex;align-items:center;background:var(--surface-3);padding:4px 8px;border-radius:var(--r-full);font-size:0.8rem">
      <a href="${escHtml(att.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary);text-decoration:none;display:flex;align-items:center;gap:4px">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
        ${escHtml(att.label || 'Anhang ' + (idx + 1))}
      </a>
      <button class="modal-btn-ghost" type="button" onclick="removeAttachment(${idx})" style="padding:2px;margin-left:6px;min-height:auto" title="Entfernen">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

function addAttachment() {
  const urlInp = document.getElementById('newAttachmentUrl');
  const labelInp = document.getElementById('newAttachmentName');
  const url = urlInp.value.trim();
  const label = labelInp.value.trim();
  if (!url) { urlInp.classList.add('shake'); setTimeout(() => urlInp.classList.remove('shake'), 400); return; }
  currentAttachments.push({ url, label: label || 'Link', addedAt: Date.now() });
  urlInp.value = '';
  labelInp.value = '';
  renderAttachments();
}

function removeAttachment(idx) {
  currentAttachments.splice(idx, 1);
  renderAttachments();
}


function rebuildAutocomplete() {
  const book = collectAddressBook();
  rebuildDatalist('dl-adressen', book.adressen);
  rebuildDatalist('dl-fahrer', book.fahrer);
  rebuildDatalist('dl-fahrzeug', book.fahrzeug);
  rebuildDatalist('dl-frachtfuehrer', book.frachtfuehrer);
}

// ─── Drag & Drop ──────────────────────────────────────────────────────────────
function setupDragDrop() {
  document.querySelectorAll('.tour-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      dragId = card.dataset.id;
      setTimeout(() => card.classList.add('dragging'), 0);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.drop-zone').forEach(z => z.classList.remove('over'));
      document.querySelectorAll('.day-col').forEach(c => c.classList.remove('drag-target'));
    });
  });
  document.querySelectorAll('.drop-zone:not(.section-hidden)').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); zone.closest('.day-col')?.classList.add('drag-target'); });
    zone.addEventListener('dragleave', e => {
      if (!zone.contains(e.relatedTarget)) { zone.classList.remove('over'); zone.closest('.day-col')?.classList.remove('drag-target'); }
    });
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('over'); zone.closest('.day-col')?.classList.remove('drag-target');
      if (!dragId) return;
      moveTour(dragId, zone.dataset.date, zone.dataset.status); dragId = null;
    });
  });
}
function moveTour(id, targetDate, targetStatus) {
  const found = findTour(id);
  if (!found) return;
  const { tour, dateKey, status } = found;
  if (dateKey === targetDate && status === targetStatus) return;
  db.tours[currentNL][dateKey][status] = db.tours[currentNL][dateKey][status].filter(t => t.id !== id);
  if (!db.tours[currentNL][targetDate]) db.tours[currentNL][targetDate] = { pending: [], done: [] };
  if (targetStatus === 'done' && !tour.verladen_am) tour.verladen_am = fmtDateTime(new Date());
  if (targetStatus === 'pending') tour.verladen_am = null;
  db.tours[currentNL][targetDate][targetStatus] = [...(db.tours[currentNL][targetDate][targetStatus] || []), tour];
  tour.updated = Date.now();
  scheduleSave(); render();
}

// ─── Niederlassung ────────────────────────────────────────────────────────────
function confirmAddNL() {
  const input = document.getElementById('nlNameInput');
  const name = input.value.trim();
  if (!name) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }
  if (db.niederlassungen.includes(name)) { toast('Niederlassung existiert bereits', 'error'); return; }
  db.niederlassungen.push(name); db.tours[name] = {}; currentNL = name;
  input.value = ''; closeModal('nlModal'); scheduleSave(); render();
  toast(`Niederlassung „${name}" hinzugefügt`, 'success');
}

// ─── Search & Dark Mode ───────────────────────────────────────────────────────
function onSearchInput(e) { searchQuery = e.target.value; renderGrid(); updateFilterBadge(); }
function clearSearch() { searchQuery = ''; document.getElementById('searchInput').value = ''; renderGrid(); updateFilterBadge(); }
function toggleDarkMode() {
  isDark = !isDark;
  document.documentElement.classList.toggle('dark-mode', isDark);
  localStorage.setItem('darkMode', isDark ? '1' : '0');
  updateThemeUI();
}
function updateThemeUI() {
  const text = document.getElementById('themeSwitchText');
  const icon = document.getElementById('themeSwitchIcon');
  const btn = document.getElementById('themeSwitchBtn');
  if (isDark) {
    if (text) text.textContent = 'Heller Modus';
    if (icon) icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
    if (btn) btn.classList.add('theme-active');
  } else {
    if (text) text.textContent = 'Dunkler Modus';
    if (icon) icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
    if (btn) btn.classList.remove('theme-active');
  }
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id)?.classList.add('open'); document.getElementById(id + '-backdrop')?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); document.getElementById(id + '-backdrop')?.classList.remove('open'); }
function openFileMenu() { openModal('fileMenu'); }

// ─── Import ───────────────────────────────────────────────────────────────────
function openImportModal() {
  const sel = document.getElementById('importNlSelect');
  sel.innerHTML = db.niederlassungen.map(nl => `<option value="${escHtml(nl)}">${escHtml(nl)}</option>`).join('');
  sel.value = currentNL; openModal('importModal');
}
function parseImportText(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(';');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const dateStr = parts[i].trim(), name = parts[i + 1].trim();
      if (!dateStr || !name) continue;
      const [d, m, y] = dateStr.split('.');
      if (!d || !m || !y) continue;
      entries.push({ dateKey: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, name });
    }
  }
  return entries;
}
function updateImportPreview() {
  const entries = parseImportText(document.getElementById('importTextarea').value);
  document.getElementById('importPreviewInfo').textContent = entries.length > 0 ? `${entries.length} Einträge erkannt` : '—';
}
function pickImportFile() { document.getElementById('importFileInput').click(); }
function loadImportFile(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { document.getElementById('importTextarea').value = ev.target.result; updateImportPreview(); };
  reader.readAsText(file);
}
function executeImport() {
  const nl = document.getElementById('importNlSelect').value;
  const entries = parseImportText(document.getElementById('importTextarea').value);
  if (!entries.length) { toast('Keine gültigen Einträge', 'error'); return; }
  db.tours[nl] = db.tours[nl] || {};
  let added = 0;
  for (const { dateKey, name } of entries) {
    if (!db.tours[nl][dateKey]) db.tours[nl][dateKey] = { pending: [], done: [] };
    db.tours[nl][dateKey].pending.push({ id: uid(), name, created: Date.now(), updated: Date.now() });
    added++;
  }
  closeModal('importModal'); currentNL = nl;
  db.version = Date.now(); // Force version change
  scheduleSave(); render();
  toast(`${added} Touren importiert`, 'success');
}

// ─── Export ───────────────────────────────────────────────────────────────────
function handleExport() {
  if (typeof XLSX === 'undefined') { toast('XLSX-Bibliothek nicht geladen', 'error'); return; }
  const wb = XLSX.utils.book_new();
  for (const nl of db.niederlassungen) {
    const rows = [['Datum', 'Wochentag', 'Name', 'Status', 'Farbe', 'Absender', 'Empfänger', 'Fahrer',
      'Fahrzeug', 'Frachtführer', 'Kommissionierliste', 'Gewicht (kg)', 'Liefertermin',
      'Ladebereit ab', 'Verladen am', 'Frachtpreis (€)', 'Besonderheiten']];
    for (const dateKey of Object.keys(db.tours[nl] || {}).sort()) {
      const day = db.tours[nl][dateKey];
      const d = parseDate(dateKey);
      const dayName = DAY_NAMES[(d.getDay() + 6) % 7];
      const dateF = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
      for (const [list, lbl] of [[(day.pending || []), 'Ausstehend'], [(day.done || []), 'Disponiert']]) {
        for (const t of list) {
          rows.push([dateF, dayName, t.name, lbl, getColor(t.farbe)?.label || '',
            t.absender || '', t.empfaenger || '', t.fahrer || '', t.fahrzeug || '',
            t.frachtfuehrer || '', t.kommissionierliste || '', t.gewicht || '',
            t.liefertermin || '', t.ladebereit_ab || '', t.verladen_am || '',
            t.frachtpreis || '', t.besonderheiten || '']);
        }
      }
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), nl.slice(0, 31));
  }
  XLSX.writeFile(wb, 'DispoBook_Export.xlsx');
  toast('Export erfolgreich', 'success');
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = '') {
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = `toast-item ${type}`; el.textContent = msg; stack.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, 2800);
}

// ─── Context Menu ────────────────────────────────────────────────────────────
let _ctxTourId = null;

function openCtxMenu(id, x, y, isRightClick = true) {
  const found = findTour(id);
  if (!found) return;
  _ctxTourId = id;
  const { tour, dateKey } = found;
  // Header
  document.getElementById('ctxTourName').textContent = tour.name;
  document.getElementById('ctxTourDate').textContent = fmtShort(dateKey) + ' ' + (DAY_NAMES[(parseDate(dateKey).getDay() + 6) % 7] || '');
  // Pre-fill date picker
  const datePicker = document.getElementById('ctxMoveDate');
  if (datePicker) {
    datePicker.value = dateKey;
  }
  // Right-click vs Left-click UI toggle
  const displayVal = isRightClick ? 'flex' : 'none';
  const blockDisplayVal = isRightClick ? 'block' : 'none';
  const moveItem = document.getElementById('ctxMoveItem');
  const deleteItem = document.getElementById('ctxDeleteItem');
  const sepAdvanced1 = document.getElementById('ctxSepAdvanced1');
  const sepAdvanced2 = document.getElementById('ctxSepAdvanced2');
  if (moveItem) moveItem.style.display = displayVal;
  if (deleteItem) deleteItem.style.display = displayVal;
  if (sepAdvanced1) sepAdvanced1.style.display = blockDisplayVal;
  if (sepAdvanced2) sepAdvanced2.style.display = blockDisplayVal;

  // Position
  const menu = document.getElementById('ctxMenu');
  menu.classList.add('open');
  // Clamp to viewport
  const mw = menu.offsetWidth || 220;
  const mh = menu.offsetHeight || Math.max(260, menu.scrollHeight);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - mw - 8) + 'px';
  menu.style.top = Math.min(y, vh - mh - 8) + 'px';
}
function closeCtxMenu() {
  document.getElementById('ctxMenu')?.classList.remove('open');
  _ctxTourId = null;
}
function ctxEdit() { const id = _ctxTourId; closeCtxMenu(); openTourDetail(id); }
function ctxDelete() { const id = _ctxTourId; closeCtxMenu(); openConfirmDelete(id); }
function ctxCopy() {
  closeCtxMenu();
  if (!_ctxTourId) return;
  const found = findTour(_ctxTourId);
  if (!found) return;
  const { tour, dateKey } = found;
  // Deep copy to ensure everything is duplicated (make it actually work)
  const copy = JSON.parse(JSON.stringify(tour));
  copy.id = uid();
  copy.name = copy.name + ' (Kopie)';
  copy.created = Date.now();
  copy.updated = Date.now();
  db.tours[currentNL][dateKey].pending.push(copy);
  scheduleSave(); render();
  toast(`„${copy.name}" kopiert`, 'success');
}
function ctxMoveToDate(targetDate) {
  closeCtxMenu();
  if (!_ctxTourId || !targetDate) return;
  moveTour(_ctxTourId, targetDate, 'pending');
  toast('Tour verschoben', 'success');
}

// ─── Sharing ──────────────────────────────────────────────────────────────────
function buildShareText(tour) {
  let lines = [];
  lines.push(`Tour: ${tour.name}`);
  if (tour.startort) lines.push(`Startort: ${tour.startort}`);
  if (tour.fahrer) lines.push(`Fahrer: ${tour.fahrer}`);
  if (tour.fahrzeug) lines.push(`Fahrzeug: ${tour.fahrzeug}`);
  if (tour.empfaenger) lines.push(`Empfänger: ${tour.empfaenger}`);
  if (tour.liefertermin) lines.push(`Liefertermin: ${tour.liefertermin.replace('T', ' ')}`);
  if (tour.besonderheiten) lines.push(`Besonderheiten: ${tour.besonderheiten}`);
  return lines.join('\n');
}

function ctxSendMail() {
  closeCtxMenu();
  if (!_ctxTourId) return;
  const found = findTour(_ctxTourId);
  if (!found) return;
  const text = buildShareText(found.tour);
  const subject = encodeURIComponent(`DispoBook Tour: ${found.tour.name}`);
  const body = encodeURIComponent(text);
  window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
}

function ctxSendWhatsApp() {
  closeCtxMenu();
  if (!_ctxTourId) return;
  const found = findTour(_ctxTourId);
  if (!found) return;
  const text = buildShareText(found.tour);
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank');
}

// ─── Stammdaten ───────────────────────────────────────────────────────────────
let currentSdTab = 'fahrer';
function openStammdatenModal() {
  currentSdTab = 'fahrer';
  openModal('stammdatenModal');
  switchSdTab('fahrer');
}
function switchSdTab(tab) {
  currentSdTab = tab;
  document.querySelectorAll('.sd-tab').forEach(b => {
    const isFracht = tab === 'frachtfuehrer' && b.textContent === 'Frachtführer';
    b.classList.toggle('active', b.textContent.toLowerCase() === tab || isFracht);
  });
  ['fahrer', 'fahrzeuge', 'frachtfuehrer', 'adressen'].forEach(t => {
    const el = document.getElementById(`sdContent${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  renderSdTab();
}
function getSdForm(tab) {
  if (tab === 'fahrer') return `<div class="sd-add-form"><div class="modal-title" style="font-size:1rem;margin-bottom:10px">Neuer Fahrer</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <input type="text" id="sdFahrerName" class="modal-input" placeholder="Name ⚑">
      <input type="text" id="sdFahrerTel" class="modal-input" placeholder="Telefon">
      <input type="text" id="sdFahrerKlasse" class="modal-input" placeholder="Führerscheinklasse">
      <select id="sdFahrerFzg" class="modal-input">
        <option value="">-- Standardfahrzeug --</option>
        ${db.stammdaten.fahrzeuge.map(f => `<option value="${f.id}">${escHtml(f.kz)}</option>`).join('')}
      </select>
    </div>
    <button class="modal-btn-primary" style="margin-top:10px" onclick="addSdFahrer()">Speichern</button>
  </div>`;

  if (tab === 'fahrzeuge') return `<div class="sd-add-form"><div class="modal-title" style="font-size:1rem;margin-bottom:10px">Neues Fahrzeug</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <input type="text" id="sdFzgKz" class="modal-input" placeholder="Kennzeichen ⚑">
      <input type="text" id="sdFzgTyp" class="modal-input" placeholder="Typ (z.B. 12t Plane)">
      <select id="sdFzgFahrer" class="modal-input">
        <option value="">-- Standardfahrer --</option>
        ${db.stammdaten.fahrer.map(f => `<option value="${f.id}">${escHtml(f.name)}</option>`).join('')}
      </select>
    </div>
    <button class="modal-btn-primary" style="margin-top:10px" onclick="addSdFahrzeug()">Speichern</button>
  </div>`;

  if (tab === 'frachtfuehrer') return `<div class="sd-add-form"><div class="modal-title" style="font-size:1rem;margin-bottom:10px">Neuer Frachtführer</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <input type="text" id="sdFrachtFirma" class="modal-input" placeholder="Firmenname ⚑">
      <input type="text" id="sdFrachtKontakt" class="modal-input" placeholder="Kontakt / Ansprechpartner">
    </div>
    <button class="modal-btn-primary" style="margin-top:10px" onclick="addSdFracht()">Speichern</button>
  </div>`;

  if (tab === 'adressen') return `<div class="sd-add-form"><div class="modal-title" style="font-size:1rem;margin-bottom:10px">Neue Adresse</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <input type="text" id="sdAdrName" class="modal-input" placeholder="Name / Firma ⚑" style="grid-column:1/-1">
      <input type="text" id="sdAdrStr" class="modal-input" placeholder="Straße & Hausnr.">
      <div style="display:flex;gap:8px">
        <input type="text" id="sdAdrPlz" class="modal-input" placeholder="PLZ" style="width:80px">
        <input type="text" id="sdAdrOrt" class="modal-input" placeholder="Ort" style="flex:1">
      </div>
    </div>
    <button class="modal-btn-primary" style="margin-top:10px" onclick="addSdAdresse()">Speichern</button>
  </div>`;
  return '';
}
function renderSdTab() {
  const c = document.getElementById(`sdContent${currentSdTab.charAt(0).toUpperCase() + currentSdTab.slice(1)}`);
  if (!c) return;
  const arr = db.stammdaten[currentSdTab] || [];

  let listHtml = '';
  if (arr.length === 0) listHtml = `<div style="text-align:center;color:var(--text-4);padding:20px">Noch keine Einträge</div>`;
  else {
    listHtml = arr.map(item => {
      let title = '', desc = '';
      if (currentSdTab === 'fahrer') {
        title = item.name;
        desc = [item.tel, item.klasse, db.stammdaten.fahrzeuge.find(f => f.id === item.fzgId)?.kz].filter(Boolean).join(' • ');
      } else if (currentSdTab === 'fahrzeuge') {
        title = item.kz;
        desc = [item.typ, db.stammdaten.fahrer.find(f => f.id === item.fahrerId)?.name].filter(Boolean).join(' • ');
      } else if (currentSdTab === 'frachtfuehrer') {
        title = item.firma; desc = item.kontakt || '';
      } else if (currentSdTab === 'adressen') {
        title = item.name; desc = [item.str, item.plz, item.ort].filter(Boolean).join(', ');
      }
      return `<div class="sd-item">
        <div class="sd-item-content">
          <div class="sd-item-title">${escHtml(title)}</div>
          <div class="sd-item-desc">${escHtml(desc)}</div>
        </div>
        <button class="modal-btn-ghost" type="button" onclick="deleteSdItem('${item.id}')" style="color:var(--danger)">Löschen</button>
      </div>`;
    }).join('');
  }

  c.innerHTML = getSdForm(currentSdTab) + listHtml;
}

function addSdFahrer() {
  const name = document.getElementById('sdFahrerName').value.trim();
  if (!name) { toast('Name erforderlich', 'error'); return; }
  db.stammdaten.fahrer.push({
    id: 'fhr_' + Date.now(), name,
    tel: document.getElementById('sdFahrerTel').value.trim(),
    klasse: document.getElementById('sdFahrerKlasse').value.trim(),
    fzgId: document.getElementById('sdFahrerFzg').value
  });
  scheduleSave(); renderSdTab(); rebuildAutocomplete();
}
function addSdFahrzeug() {
  const kz = document.getElementById('sdFzgKz').value.trim();
  if (!kz) { toast('Kennzeichen erforderlich', 'error'); return; }
  db.stammdaten.fahrzeuge.push({
    id: 'fzg_' + Date.now(), kz,
    typ: document.getElementById('sdFzgTyp').value.trim(),
    fahrerId: document.getElementById('sdFzgFahrer').value
  });
  scheduleSave(); renderSdTab(); rebuildAutocomplete();
}
function addSdFracht() {
  const firma = document.getElementById('sdFrachtFirma').value.trim();
  if (!firma) { toast('Firma erforderlich', 'error'); return; }
  db.stammdaten.frachtfuehrer.push({
    id: 'frc_' + Date.now(), firma,
    kontakt: document.getElementById('sdFrachtKontakt').value.trim()
  });
  scheduleSave(); renderSdTab(); rebuildAutocomplete();
}
function addSdAdresse() {
  const name = document.getElementById('sdAdrName').value.trim();
  if (!name) { toast('Name erforderlich', 'error'); return; }
  db.stammdaten.adressen.push({
    id: 'adr_' + Date.now(), name,
    str: document.getElementById('sdAdrStr').value.trim(),
    plz: document.getElementById('sdAdrPlz').value.trim(),
    ort: document.getElementById('sdAdrOrt').value.trim()
  });
  scheduleSave(); renderSdTab(); rebuildAutocomplete();
}
function deleteSdItem(id) {
  if (!confirm('Diesen Eintrag wirklich löschen?')) return;
  const idx = db.stammdaten[currentSdTab].findIndex(i => i.id === id);
  if (idx > -1) {
    db.stammdaten[currentSdTab].splice(idx, 1);
    scheduleSave(); renderSdTab(); rebuildAutocomplete();
  }
}

// ─── Tour Auto-Fill Logic ────────────────────────────────────────────────────────
document.getElementById('detailFahrzeug')?.addEventListener('change', (e) => {
  const kz = e.target.value.trim();
  const fahrerInp = document.getElementById('detailFahrer');
  if (kz && db.stammdaten?.fahrzeuge && fahrerInp && !fahrerInp.value) {
    const fzg = db.stammdaten.fahrzeuge.find(f => f.kz === kz);
    if (fzg && fzg.fahrerId) {
      const fahrer = db.stammdaten.fahrer.find(f => f.id === fzg.fahrerId);
      if (fahrer) {
        fahrerInp.value = fahrer.name;
      }
    }
  }
});
document.getElementById('detailFahrer')?.addEventListener('change', (e) => {
  const name = e.target.value.trim();
  const fzgInp = document.getElementById('detailFahrzeug');
  if (name && db.stammdaten?.fahrer && fzgInp && !fzgInp.value) {
    const fahrer = db.stammdaten.fahrer.find(f => f.name === name);
    if (fahrer && fahrer.fzgId) {
      const fzg = db.stammdaten.fahrzeuge.find(f => f.id === fahrer.fzgId);
      if (fzg) {
        fzgInp.value = fzg.kz;
      }
    }
  }
});

// ─── Keyboard ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['tourDetailModal', 'fileMenu', 'nlModal', 'importModal', 'confirmDeleteModal', 'addPromptModal', 'renameModal'].forEach(closeModal);
    closeCtxMenu();
    if (filterPanelOpen) toggleFilterPanel();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); document.getElementById('searchInput')?.focus(); }
});
document.addEventListener('click', e => {
  if (!filterPanelOpen) {
    const menu = document.getElementById('ctxMenu');
    if (menu?.classList.contains('open') && !menu.contains(e.target)) closeCtxMenu();
    return;
  }
  const panel = document.getElementById('filterPanel');
  const btn = document.getElementById('filterBtn');
  if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) toggleFilterPanel();
  const menu = document.getElementById('ctxMenu');
  if (menu?.classList.contains('open') && !menu.contains(e.target)) closeCtxMenu();
});

// ─── Gemini KI Import ─────────────────────────────────────────────────────────
function promptGeminiApiKey() {
  const current = localStorage.getItem('geminiApiKey') || '';
  const inp = document.getElementById('geminiKeyInput');
  if (inp) inp.value = current;
  openModal('geminiModal');
}

function saveGeminiApiKey() {
  const inp = document.getElementById('geminiKeyInput');
  if (!inp) return;
  const key = inp.value.trim();
  localStorage.setItem('geminiApiKey', key);
  closeModal('geminiModal');
  toast('API-Schlüssel gespeichert', 'success');
}

async function handlePdfUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64Data = e.target.result;

    // UI prep
    document.getElementById('pdfInputKI').value = '';
    const iframe = document.getElementById('pdfIframeKI');
    const spinner = document.getElementById('pdfSpinnerKI');
    const modalContent = document.querySelector('#tourDetailModal .modal-content-detail');

    // Clear form
    const map = {
      detailName: '', detailAbsender: '', detailEmpfaenger: '',
      detailFahrer: '', detailFahrzeug: '', detailFrachtfuehrer: '',
      detailKommissionierliste: '', detailFrachtpreis: '', detailBesonderheiten: '',
      detailLiefertermin: '', detailVerladen: '',
      detailTransportnummer: '', detailTourtyp: '', detailStartort: '',
      detailEmpfAnsprechpartner: '', detailEmpfRampe: '', detailEmpfZeitfenster: '',
      detailReferenznummer: ''
    };
    for (const [fid, val] of Object.entries(map)) {
      const el = document.getElementById(fid);
      if (el) el.value = val;
    }
    document.getElementById('detailStatus').value = 'pending';
    renderColorPicker('');
    currentPositions = [];
    renderPositions();
    currentAttachments = [];
    renderAttachments();

    // Layout activate
    modalContent.classList.add('split-active');
    document.getElementById('pdfSideKI').style.display = 'block';

    // Use Object URL for better browser rendering and append parameters to hide toolbars
    if (iframe.src && iframe.src.startsWith('blob:')) {
      URL.revokeObjectURL(iframe.src.split('#')[0]);
    }
    const objectUrl = URL.createObjectURL(file);
    iframe.src = objectUrl + "#toolbar=0&navpanes=0&view=FitH";

    spinner.style.display = 'flex';
    openModal('tourDetailModal');

    try {
      const parsedData = await callGeminiAPI(base64Data);
      applyKiDataToForm(parsedData);
      toast('Dokument erfolgreich analysiert', 'success');
    } catch (err) {
      toast('Fehler bei der KI-Analyse', 'error');
      console.error(err);
    } finally {
      spinner.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
}

async function callGeminiAPI(base64Data) {
  const apiKey = localStorage.getItem('geminiApiKey');
  if (!apiKey) { throw new Error('No API Key'); }

  const base64Clean = base64Data.split(',')[1];

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: "Du bist ein erfahrener Disponent. Extrahiere die Frachtdaten aus dem PDF in das JSON-Schema.\n1. 'bezeichnung': Benenne die Tour nach dem Lieferort/Empfangsort (z.B. 'Berlin' oder 'Hub Egelsbach').\n2. 'startort': Nimm standardmäßig die Absender-Adresse (Firma + Ort), falls nicht anders angegeben.\n3. 'fahrer' & 'fahrzeug': Extrahiere Fahrername und Kennzeichen, falls auf dem Dokument vorhanden (z.B. 'Fahrer: Armin', 'Zugfzg: GI-ST 123').\n4. 'liefertermin' & 'verladen': Extrahiere Zustelltermin/Liefertermin (als ISO-Datum YYYY-MM-DDTHH:MM falls möglich) und Verladetermin.\n5. 'sendungspositionen': Mache die Extraktion intelligenter. 'bezeichnung' soll die Verpackungsart und Warenbezeichnung enthalten (z.B. 'Euro-Flachpalette Brot'). 'anzahl' die Menge. 'gewicht' das Gewicht in kg. 'l', 'b', 'h' (in mm) falls Abmessungen vorhanden sind (Länge, Breite, Höhe).\n6. 'lademeter', 'gesamtgewicht', 'transportnummer', 'absender', 'empfaenger', 'referenznummer' wie gehabt extrahieren." },
          { inlineData: { mimeType: "application/pdf", data: base64Clean } }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            bezeichnung: { type: "STRING" },
            transportnummer: { type: "STRING" },
            startort: { type: "STRING" },
            absender: { type: "STRING" },
            empfaenger: { type: "STRING" },
            empf_ansprechpartner: { type: "STRING" },
            empf_rampe: { type: "STRING" },
            empf_zeitfenster: { type: "STRING" },
            referenznummer: { type: "STRING" },
            fahrer: { type: "STRING" },
            fahrzeug: { type: "STRING" },
            liefertermin: { type: "STRING" },
            verladen: { type: "STRING" },
            gesamtgewicht: { type: "NUMBER" },
            lademeter: { type: "NUMBER" },
            sendungspositionen: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  anzahl: { type: "NUMBER" },
                  bezeichnung: { type: "STRING" },
                  gewicht: { type: "NUMBER" },
                  l: { type: "NUMBER" },
                  b: { type: "NUMBER" },
                  h: { type: "NUMBER" }
                }
              }
            }
          }
        }
      }
    })
  });

  if (!response.ok) throw new Error('API request failed');
  const data = await response.json();
  const parsedText = data.candidates[0].content.parts[0].text;
  return JSON.parse(parsedText);
}

function applyKiDataToForm(ki) {
  const mapStr = {
    detailName: ki.bezeichnung || 'Neue Tour aus PDF',
    detailTransportnummer: ki.transportnummer || '',
    detailStartort: ki.startort || ki.absender || '',
    detailAbsender: ki.absender || '',
    detailEmpfaenger: ki.empfaenger || '',
    detailEmpfAnsprechpartner: ki.empf_ansprechpartner || '',
    detailEmpfRampe: ki.empf_rampe || '',
    detailEmpfZeitfenster: ki.empf_zeitfenster || '',
    detailReferenznummer: ki.referenznummer || '',
    detailFahrer: ki.fahrer || '',
    detailFahrzeug: ki.fahrzeug || ''
  };
  for (const [id, val] of Object.entries(mapStr)) {
    const el = document.getElementById(id);
    if (el && val) el.value = val;
  }

  if (ki.liefertermin) {
    try {
      const d = new Date(ki.liefertermin);
      if (!isNaN(d.getTime())) document.getElementById('detailLiefertermin').value = d.toISOString().slice(0, 16);
    } catch (e) { }
  }
  if (ki.verladen) {
    try {
      const d = new Date(ki.verladen);
      if (!isNaN(d.getTime())) document.getElementById('detailVerladen').value = d.toISOString().slice(0, 16);
    } catch (e) { }
  }

  editingStagingId = uid();
  stagingTours.push({ id: editingStagingId, name: mapStr.detailName });
  editingTourId = null;

  // Pre-fill & show the date picker - use liefertermin date or today
  const dateWrap = document.getElementById('detailDateWrap');
  const dateInp = document.getElementById('detailDate');
  if (dateWrap) dateWrap.style.display = '';
  if (dateInp) {
    let defaultDate = fmt(new Date());
    if (ki.liefertermin) {
      try {
        const d = new Date(ki.liefertermin);
        if (!isNaN(d.getTime())) defaultDate = fmt(d);
      } catch (_) { }
    }
    dateInp.value = defaultDate;
  }

  // Map AI sendungspositionen to new simple fields
  if (ki.sendungspositionen && ki.sendungspositionen.length > 0) {
    let totalGewicht = 0;
    let maxL = 0, maxB = 0, maxH = 0;

    ki.sendungspositionen.forEach(p => {
      const anz = p.anzahl || 1;
      if (p.gewicht) totalGewicht += p.gewicht * (p.gewicht < 100 && anz > 1 ? anz : 1); // rough guess if item weight or total

      if (p.l && p.l > maxL) maxL = p.l;
      if (p.b && p.b > maxB) maxB = p.b;
      if (p.h && p.h > maxH) maxH = p.h;
    });

    if (totalGewicht > 0) document.getElementById('detailGewicht').value = Math.round(totalGewicht);
    if (ki.lademeter) document.getElementById('detailLademeter').value = ki.lademeter;

    // Convert mm to cm for the UI
    if (maxL > 0) document.getElementById('detailMassL').value = Math.round(maxL / 10);
    if (maxB > 0) document.getElementById('detailMassB').value = Math.round(maxB / 10);
    if (maxH > 0) document.getElementById('detailMassH').value = Math.round(maxH / 10);
  }
}

// ─── ADDRESS AUTOCOMPLETE (PHOTON) ───────────────────────────────────────────
let acTimeout = null;

function initAddrAutocomplete() {
  const inputs = document.querySelectorAll('.addr-autocomplete');
  inputs.forEach(input => {
    input.addEventListener('input', (e) => handleAcInput(e.target));
    input.addEventListener('focus', (e) => {
      if (e.target.value.length >= 3) handleAcInput(e.target);
    });
    // Hide when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.addr-ac-wrap')) {
        const dd = input.nextElementSibling;
        if (dd) dd.classList.remove('visible');
      }
    });
  });
}

async function handleAcInput(input) {
  const query = input.value.trim();
  const dropdown = input.nextElementSibling;

  if (query.length < 3) {
    dropdown.classList.remove('visible');
    return;
  }

  clearTimeout(acTimeout);
  acTimeout = setTimeout(async () => {
    try {
      // Photon API - no key needed, fast, highly rated for OpenStreetMap data
      const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lang=de`);
      if (!res.ok) return;
      const data = await res.json();

      if (!data.features || data.features.length === 0) {
        dropdown.classList.remove('visible');
        return;
      }

      dropdown.innerHTML = data.features.map(f => {
        const p = f.properties;
        // Build address string nicely
        let mainText = p.name || '';
        let subTextParts = [];
        if (p.street) subTextParts.push(p.street + (p.housenumber ? ' ' + p.housenumber : ''));
        if (p.postcode) subTextParts.push(p.postcode);
        if (p.city) subTextParts.push(p.city);
        else if (p.state) subTextParts.push(p.state);

        const subText = subTextParts.join(', ');
        if (!mainText && subText) {
          mainText = subText;
          subText = p.country || '';
        }

        const fullStr = mainText + (subText ? ', ' + subText : '');
        return `<div class="addr-ac-item" onclick="selectAcItem('${input.id}', '${escHtml(fullStr)}')">
                  ${escHtml(mainText)}
                  ${subText ? `<small>${escHtml(subText)}</small>` : ''}
                </div>`;
      }).join('');

      dropdown.classList.add('visible');
    } catch (e) {
      console.error('Autocomplete error', e);
    }
  }, 350);
}

function selectAcItem(inputId, value) {
  const input = document.getElementById(inputId);
  if (input) {
    input.value = value;
    const dropdown = input.nextElementSibling;
    if (dropdown) dropdown.classList.remove('visible');
  }
}

// Init on load
document.addEventListener('DOMContentLoaded', initAddrAutocomplete);
