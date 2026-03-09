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
  const sets = { absender: new Set(), empfaenger: new Set(), fahrer: new Set(), fahrzeug: new Set() };
  for (const nlKey of Object.keys(db.tours || {})) {
    for (const day of Object.values(db.tours[nlKey] || {})) {
      for (const t of [...(day.pending || []), ...(day.done || [])]) {
        if (t.absender) sets.absender.add(t.absender);
        if (t.empfaenger) sets.empfaenger.add(t.empfaenger);
        if (t.fahrer) sets.fahrer.add(t.fahrer);
        if (t.fahrzeug) sets.fahrzeug.add(t.fahrzeug);
      }
    }
  }
  return { absender: [...sets.absender], empfaenger: [...sets.empfaenger], fahrer: [...sets.fahrer], fahrzeug: [...sets.fahrzeug] };
}
function rebuildDatalist(id, items) {
  let dl = document.getElementById(id);
  if (!dl) { dl = document.createElement('datalist'); dl.id = id; document.body.appendChild(dl); }
  dl.innerHTML = items.map(v => `<option value="${escHtml(v)}">`).join('');
}

// ─── File Handling ────────────────────────────────────────────────────────────
async function pickFile() {
  try {
    [fileHandle] = await window.showOpenFilePicker({ types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
    const file = await fileHandle.getFile();
    db = JSON.parse(await file.text());
    lastSavedVersion = db.version;
    initApp();
  } catch (e) { if (e.name !== 'AbortError') toast('Fehler beim Öffnen: ' + e.message, 'error'); }
}
async function createNewFile() {
  try {
    fileHandle = await window.showSaveFilePicker({ suggestedName: 'data.json', types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
    db = { version: Date.now(), niederlassungen: ['Haupt'], tours: { 'Haupt': {} }, deletedTours: {} };
    await saveFile(); lastSavedVersion = db.version; initApp();
  } catch (e) { if (e.name !== 'AbortError') toast('Fehler beim Erstellen: ' + e.message, 'error'); }
}
async function saveFile() {
  if (!fileHandle) return;
  db.version = Date.now(); setSyncStatus('saving');
  try {
    const w = await fileHandle.createWritable();
    await w.write(JSON.stringify(db, null, 2)); await w.close();
    lastSavedVersion = db.version; setSyncStatus('saved');
  } catch { setSyncStatus('error'); toast('Fehler beim Speichern!', 'error'); }
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveFile, 600); }
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
  updateThemeUI(); render();
  setInterval(pollFile, 8000);
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() { renderNLSwitcher(); renderWeekLabel(); renderStats(); renderGrid(); updateFilterBadge(); }

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
  const end = addDays(currentWeekStart, 6);
  const kw = getISOWeek(currentWeekStart);
  const s = d => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
  document.getElementById('weekLabel').textContent = `KW ${kw} · ${s(currentWeekStart)} – ${s(end)}`;
}
function changeWeek(dir) { currentWeekStart = addDays(currentWeekStart, dir * 7); render(); }
function goToday() { currentWeekStart = getMonday(new Date()); render(); }

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

  const daySelect = document.getElementById('addTourDaySelect');
  if (daySelect) {
    const prev = daySelect.value;
    daySelect.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(currentWeekStart, i);
      const key = fmt(d);
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `${DAY_NAMES[i].slice(0, 2)} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
      daySelect.appendChild(opt);
    }
    if (prev && daySelect.querySelector(`option[value="${prev}"]`)) daySelect.value = prev;
    else if (daySelect.querySelector(`option[value="${today}"]`)) daySelect.value = today;
  }

  grid.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(currentWeekStart, i);
    const key = fmt(d);
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
  }
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

  return `<div class="tour-card ${isDone ? 'done' : ''} ${color ? 'tour-card-colored' : ''}" draggable="true" data-id="${t.id}" ${colorStyle}>
    <span class="tour-drag-handle">⠿</span>
    <div class="tour-card-body">
      <div class="tour-name-row">
        <span class="tour-name">${escHtml(t.name)}</span>
        ${color ? `<span class="tour-color-dot" style="background:${color.hex}" title="${color.label}"></span>` : ''}
      </div>
      ${t.empfaenger ? `<div class="tour-empfaenger">📦 ${escHtml(t.empfaenger)}</div>` : ''}
      ${chips.length ? `<div class="tour-chips">${chips.join('')}</div>` : ''}
    </div>
    <div class="tour-btns">
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
function setupCardEvents() {
  document.querySelectorAll('.tour-btn.toggle').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); toggleTourStatus(btn.dataset.id); }));
  document.querySelectorAll('.tour-btn.del').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); openConfirmDelete(btn.dataset.id); }));
  document.querySelectorAll('.tour-btn.detail').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); openTourDetail(btn.dataset.id); }));
  document.querySelectorAll('.tour-card').forEach(card =>
    card.addEventListener('dblclick', e => {
      if (!e.target.closest('.tour-btns') && !e.target.closest('.tour-drag-handle'))
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

// ─── Add Tour Bar ─────────────────────────────────────────────────────────────
function addTourFromBar() {
  const nameInput = document.getElementById('addTourName');
  const daySelect = document.getElementById('addTourDaySelect');
  const name = nameInput.value.trim();
  if (!name) { nameInput.classList.add('shake'); setTimeout(() => nameInput.classList.remove('shake'), 400); return; }
  const dateKey = daySelect.value;
  if (!db.tours[currentNL]) db.tours[currentNL] = {};
  if (!db.tours[currentNL][dateKey]) db.tours[currentNL][dateKey] = { pending: [], done: [] };
  db.tours[currentNL][dateKey].pending.push({ id: uid(), name, created: Date.now(), updated: Date.now() });
  nameInput.value = ''; nameInput.focus();
  scheduleSave(); render();
  const col = document.querySelector(`.day-col[data-date="${dateKey}"]`);
  if (col) { col.classList.add('remote-flash'); setTimeout(() => col.classList.remove('remote-flash'), 1400); }
  toast(`Tour „${name}" hinzugefügt`, 'success');
}
function addTourKeyDown(e) { if (e.key === 'Enter') addTourFromBar(); }

// ─── Tour Detail Modal ────────────────────────────────────────────────────────
function openTourDetail(id) {
  const found = findTour(id);
  if (!found) return;
  editingTourId = id;
  const { tour, status } = found;
  const map = {
    detailName: tour.name, detailAbsender: tour.absender, detailEmpfaenger: tour.empfaenger,
    detailFahrer: tour.fahrer, detailFahrzeug: tour.fahrzeug, detailFrachtfuehrer: tour.frachtfuehrer,
    detailKommissionierliste: tour.kommissionierliste, detailGewicht: tour.gewicht,
    detailFrachtpreis: tour.frachtpreis, detailBesonderheiten: tour.besonderheiten,
  };
  for (const [fid, val] of Object.entries(map)) {
    const el = document.getElementById(fid);
    if (el) el.value = val || '';
  }
  const dtFields = { detailLiefertermin: tour.liefertermin, detailLadebereit: tour.ladebereit_ab, detailVerladen: tour.verladen_am };
  for (const [fid, val] of Object.entries(dtFields)) {
    const el = document.getElementById(fid);
    if (el) el.value = fmtDateTimeLocal(val);
  }
  document.getElementById('detailStatus').value = status;
  renderColorPicker(tour.farbe || '');
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
  if (!editingTourId) return;
  const found = findTour(editingTourId);
  if (!found) return;
  const nameEl = document.getElementById('detailName');
  const name = nameEl.value.trim();
  if (!name) {
    nameEl.classList.add('shake');
    nameEl.focus();
    setTimeout(() => nameEl.classList.remove('shake'), 400);
    return;
  }
  const { tour, dateKey, status: oldStatus } = found;
  tour.name = name;
  tour.absender = document.getElementById('detailAbsender').value.trim() || null;
  tour.empfaenger = document.getElementById('detailEmpfaenger').value.trim() || null;
  tour.fahrer = document.getElementById('detailFahrer').value.trim() || null;
  tour.fahrzeug = document.getElementById('detailFahrzeug').value.trim() || null;
  tour.frachtfuehrer = document.getElementById('detailFrachtfuehrer').value.trim() || null;
  tour.kommissionierliste = document.getElementById('detailKommissionierliste').value.trim() || null;
  const g = parseFloat(document.getElementById('detailGewicht').value);
  tour.gewicht = isNaN(g) ? null : g;
  const p = parseFloat(document.getElementById('detailFrachtpreis').value);
  tour.frachtpreis = isNaN(p) ? null : p;
  tour.liefertermin = document.getElementById('detailLiefertermin').value || null;
  tour.ladebereit_ab = document.getElementById('detailLadebereit').value || null;
  tour.verladen_am = document.getElementById('detailVerladen').value || null;
  tour.besonderheiten = document.getElementById('detailBesonderheiten').value.trim() || null;

  // Read color from picker state
  const selectedSwatch = document.querySelector('#detailColorPicker .color-swatch.selected');
  tour.farbe = selectedSwatch ? selectedSwatch.getAttribute('title') !== 'Keine'
    ? TOUR_COLORS.find(c => c.hex === selectedSwatch.style.background || c.label === selectedSwatch.title)?.id || null
    : null : null;

  // Handle status change
  const newStatus = document.getElementById('detailStatus').value;
  if (newStatus !== oldStatus) {
    const day = db.tours[currentNL][dateKey];
    day[oldStatus] = day[oldStatus].filter(t => t.id !== tour.id);
    if (!day[newStatus]) day[newStatus] = [];
    if (newStatus === 'done' && !tour.verladen_am) tour.verladen_am = fmtDateTime(new Date());
    if (newStatus === 'pending') tour.verladen_am = null;
    day[newStatus].push(tour);
  }
  tour.updated = Date.now();
  closeModal('tourDetailModal');
  scheduleSave(); render();
  toast('Tour gespeichert', 'success');
}
function deleteTourFromDetail() {
  if (!editingTourId) return;
  closeModal('tourDetailModal');
  openConfirmDelete(editingTourId);
  editingTourId = null;
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────
function rebuildAutocomplete() {
  const book = collectAddressBook();
  rebuildDatalist('dl-absender', book.absender);
  rebuildDatalist('dl-empfaenger', book.empfaenger);
  rebuildDatalist('dl-fahrer', book.fahrer);
  rebuildDatalist('dl-fahrzeug', book.fahrzeug);
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
  closeModal('importModal'); currentNL = nl; scheduleSave(); render();
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

// ─── Keyboard ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['tourDetailModal', 'fileMenu', 'nlModal', 'importModal', 'confirmDeleteModal'].forEach(closeModal);
    if (filterPanelOpen) toggleFilterPanel();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); document.getElementById('searchInput')?.focus(); }
});
document.addEventListener('click', e => {
  if (!filterPanelOpen) return;
  const panel = document.getElementById('filterPanel');
  const btn = document.getElementById('filterBtn');
  if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) toggleFilterPanel();
});
