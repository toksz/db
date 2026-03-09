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
let editingTourId = null;
let dragId = null;

// ─── Utilities ────────────────────────────────────────────────────────────────
function uid() { return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }
function fmt(date) { return date.toISOString().slice(0, 10); }
function parseDate(str) { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d); }
function getMonday(date) {
  const d = new Date(date); const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1)); d.setHours(0, 0, 0, 0); return d;
}
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function fmtShort(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.`;
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

const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

// ─── File Handling ────────────────────────────────────────────────────────────
async function pickFile() {
  try {
    [fileHandle] = await window.showOpenFilePicker({
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
    });
    const file = await fileHandle.getFile();
    db = JSON.parse(await file.text());
    lastSavedVersion = db.version;
    initApp();
  } catch (e) {
    if (e.name !== 'AbortError') toast('Fehler beim Öffnen: ' + e.message, 'error');
  }
}

async function createNewFile() {
  try {
    fileHandle = await window.showSaveFilePicker({
      suggestedName: 'data.json',
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
    });
    db = { version: Date.now(), niederlassungen: ['Haupt'], tours: { 'Haupt': {} }, deletedTours: {} };
    await saveFile();
    lastSavedVersion = db.version;
    initApp();
  } catch (e) {
    if (e.name !== 'AbortError') toast('Fehler beim Erstellen: ' + e.message, 'error');
  }
}

async function saveFile() {
  if (!fileHandle) return;
  db.version = Date.now();
  setSyncStatus('saving');
  try {
    const w = await fileHandle.createWritable();
    await w.write(JSON.stringify(db, null, 2));
    await w.close();
    lastSavedVersion = db.version;
    setSyncStatus('saved');
  } catch {
    setSyncStatus('error');
    toast('Fehler beim Speichern!', 'error');
  }
}

function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveFile, 600); }

async function pollFile() {
  if (!fileHandle) return;
  try {
    const file = await fileHandle.getFile();
    const remote = JSON.parse(await file.text());
    if (remote.version !== lastSavedVersion && remote.version !== db.version) {
      document.getElementById('conflictBanner').classList.add('visible');
    }
  } catch (_) {}
}

function setSyncStatus(state) {
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  const badge = document.getElementById('syncBadge');
  dot.className = 'sync-dot' + (state === 'saving' ? ' saving' : state === 'error' ? ' error' : '');
  if (state === 'saving') { label.textContent = 'Speichert…'; badge.classList.remove('visible'); }
  else if (state === 'saved') {
    const n = new Date();
    label.textContent = `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`;
    badge.classList.add('visible');
    setTimeout(() => badge.classList.remove('visible'), 2500);
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
  updateThemeUI();
  render();
  setInterval(pollFile, 8000);
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  renderNLSwitcher();
  renderWeekLabel();
  renderStats();
  renderGrid();
}

// Niederlassung switcher in header
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
  // Count badge
  const tours = db.tours[currentNL] || {};
  let total = 0;
  for (const day of Object.values(tours)) total += (day.pending||[]).length + (day.done||[]).length;
  const badge = document.getElementById('nlSwitcherCount');
  if (badge) { badge.textContent = total; badge.style.display = total > 0 ? '' : 'none'; }
}

function switchNL(dir) {
  const nls = db.niederlassungen || [];
  const idx = nls.indexOf(currentNL);
  const ni = idx + dir;
  if (ni >= 0 && ni < nls.length) { currentNL = nls[ni]; render(); }
}

function renderWeekLabel() {
  const end = addDays(currentWeekStart, 6);
  const kw = getISOWeek(currentWeekStart);
  const s = d => `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.`;
  document.getElementById('weekLabel').textContent = `KW ${kw} · ${s(currentWeekStart)} – ${s(end)}`;
}

function changeWeek(dir) { currentWeekStart = addDays(currentWeekStart, dir * 7); render(); }
function goToday() { currentWeekStart = getMonday(new Date()); render(); }

function renderStats() {
  const row = document.getElementById('statsRow');
  if (!row) return;
  const tours = db.tours[currentNL] || {};
  let pending = 0, done = 0, totalWeight = 0, totalPrice = 0, hasWeight = false, hasPrice = false;
  for (const day of Object.values(tours)) {
    pending += (day.pending || []).length;
    done += (day.done || []).length;
    for (const t of [...(day.pending || []), ...(day.done || [])]) {
      if (t.gewicht) { totalWeight += Number(t.gewicht); hasWeight = true; }
      if (t.frachtpreis) { totalPrice += Number(t.frachtpreis); hasPrice = true; }
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
    ${hasWeight ? `<div class="stat-pill">⚖ <strong>${fmtWeight(totalWeight)}</strong></div>` : ''}
    ${hasPrice ? `<div class="stat-pill">💶 <strong>${fmtPrice(totalPrice)}</strong></div>` : ''}
  `;
}

function renderGrid() {
  const grid = document.getElementById('daysGrid');
  const today = fmt(new Date());
  const tours = db.tours[currentNL] || {};
  const q = searchQuery.toLowerCase();

  // Populate day select in add-tour bar
  const daySelect = document.getElementById('addTourDaySelect');
  if (daySelect) {
    const prev = daySelect.value;
    daySelect.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(currentWeekStart, i);
      const key = fmt(d);
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `${DAY_NAMES[i].slice(0, 2)} ${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.`;
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
    const filter = t => !q || t.name.toLowerCase().includes(q)
      || (t.empfaenger||'').toLowerCase().includes(q)
      || (t.absender||'').toLowerCase().includes(q)
      || (t.kommissionierliste||'').toLowerCase().includes(q);
    const pending = (dayData.pending || []).filter(filter);
    const done = (dayData.done || []).filter(filter);
    const total = pending.length + done.length;
    const isToday = key === today;

    const col = document.createElement('div');
    col.className = 'day-col' + (isToday ? ' today' : '');
    col.dataset.date = key;
    col.innerHTML = `
      <div class="day-head">
        <div class="day-name-wrap">
          <div class="day-name">${DAY_NAMES[i]}${isToday ? ' <span class="today-badge">HEUTE</span>' : ''}</div>
          <div class="day-date">${fmtShort(key)}</div>
        </div>
        <div class="day-total">${total}</div>
      </div>
      <div class="section section-pending">
        <div class="section-head">
          <span class="section-title">Ausstehend</span>
          <span class="section-count">${pending.length}</span>
        </div>
        <div class="drop-zone" id="pending-${key}" data-date="${key}" data-status="pending">
          ${pending.length === 0 ? '<div class="drop-empty">Keine ausstehenden Touren</div>' : pending.map(t => renderTourCard(t, false)).join('')}
        </div>
      </div>
      <div class="section section-done">
        <div class="section-head">
          <span class="section-title">Disponiert</span>
          <span class="section-count">${done.length}</span>
        </div>
        <div class="drop-zone" id="done-${key}" data-date="${key}" data-status="done">
          ${done.length === 0 ? '<div class="drop-empty">Noch keine disponierten Touren</div>' : done.map(t => renderTourCard(t, true)).join('')}
        </div>
      </div>
    `;
    grid.appendChild(col);
  }
  setupDragDrop();
  setupCardEvents();
}

function renderTourCard(t, isDone) {
  const metaParts = [];
  if (t.empfaenger) metaParts.push(`<span class="tour-meta-chip" title="Empfänger">📦 ${escHtml(t.empfaenger)}</span>`);
  if (t.gewicht) metaParts.push(`<span class="tour-meta-chip" title="Gewicht">⚖ ${fmtWeight(t.gewicht)}</span>`);
  if (t.frachtpreis) metaParts.push(`<span class="tour-meta-chip" title="Frachtpreis">💶 ${fmtPrice(t.frachtpreis)}</span>`);
  if (t.besonderheiten) metaParts.push(`<span class="tour-meta-chip tour-meta-warn" title="Besonderheiten">⚠ ${escHtml(t.besonderheiten)}</span>`);
  return `
    <div class="tour-card ${isDone ? 'done' : ''}" draggable="true" data-id="${t.id}">
      <span class="tour-drag-handle">⠿</span>
      <div class="tour-card-body">
        <div class="tour-name">${escHtml(t.name)}</div>
        ${metaParts.length ? `<div class="tour-meta">${metaParts.join('')}</div>` : ''}
      </div>
      <div class="tour-btns">
        <button class="tour-btn toggle" data-id="${t.id}" title="${isDone ? 'Als ausstehend markieren' : 'Als disponiert markieren'}">
          ${isDone
            ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`
            : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`
          }
        </button>
        <button class="tour-btn detail" data-id="${t.id}" title="Details / Bearbeiten">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="tour-btn del" data-id="${t.id}" title="Löschen">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
  `;
}

// ─── Card Events ──────────────────────────────────────────────────────────────
function setupCardEvents() {
  document.querySelectorAll('.tour-btn.toggle').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); toggleTourStatus(btn.dataset.id); }));
  document.querySelectorAll('.tour-btn.del').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); deleteTour(btn.dataset.id); }));
  document.querySelectorAll('.tour-btn.detail').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); openTourDetail(btn.dataset.id); }));
  document.querySelectorAll('.tour-card').forEach(card =>
    card.addEventListener('dblclick', e => {
      if (!e.target.closest('.tour-btns') && !e.target.closest('.tour-drag-handle'))
        openTourDetail(card.dataset.id);
    }));
}

// ─── Tour Data Helpers ────────────────────────────────────────────────────────
function findTour(id) {
  const nlTours = db.tours[currentNL] || {};
  for (const [dateKey, day] of Object.entries(nlTours)) {
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
    tour.verladen_am = new Date().toISOString().slice(0, 16);
    day.done = [...(day.done || []), tour];
  } else {
    day.done = day.done.filter(t => t.id !== id);
    tour.verladen_am = null;
    day.pending = [...(day.pending || []), tour];
  }
  tour.updated = Date.now();
  scheduleSave(); render();
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
  // Flash the target column
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
  const { tour } = found;
  document.getElementById('detailName').value = tour.name || '';
  document.getElementById('detailAbsender').value = tour.absender || '';
  document.getElementById('detailEmpfaenger').value = tour.empfaenger || '';
  document.getElementById('detailKommissionierliste').value = tour.kommissionierliste || '';
  document.getElementById('detailGewicht').value = tour.gewicht || '';
  document.getElementById('detailLadebereit').value = fmtDateTimeLocal(tour.ladebereit_ab);
  document.getElementById('detailVerladen').value = fmtDateTimeLocal(tour.verladen_am);
  document.getElementById('detailFrachtpreis').value = tour.frachtpreis || '';
  document.getElementById('detailBesonderheiten').value = tour.besonderheiten || '';
  openModal('tourDetailModal');
}

function saveTourDetail() {
  if (!editingTourId) return;
  const found = findTour(editingTourId);
  if (!found) return;
  const { tour } = found;
  const name = document.getElementById('detailName').value.trim();
  if (name) tour.name = name;
  tour.absender = document.getElementById('detailAbsender').value.trim() || null;
  tour.empfaenger = document.getElementById('detailEmpfaenger').value.trim() || null;
  tour.kommissionierliste = document.getElementById('detailKommissionierliste').value.trim() || null;
  const g = parseFloat(document.getElementById('detailGewicht').value);
  tour.gewicht = isNaN(g) ? null : g;
  tour.ladebereit_ab = document.getElementById('detailLadebereit').value || null;
  tour.verladen_am = document.getElementById('detailVerladen').value || null;
  const p = parseFloat(document.getElementById('detailFrachtpreis').value);
  tour.frachtpreis = isNaN(p) ? null : p;
  tour.besonderheiten = document.getElementById('detailBesonderheiten').value.trim() || null;
  tour.updated = Date.now();
  closeModal('tourDetailModal');
  scheduleSave(); render();
  toast('Tour gespeichert', 'success');
}

function deleteTourFromDetail() {
  if (!editingTourId) return;
  closeModal('tourDetailModal');
  deleteTour(editingTourId);
  editingTourId = null;
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
  document.querySelectorAll('.drop-zone').forEach(zone => {
    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.classList.add('over');
      zone.closest('.day-col')?.classList.add('drag-target');
    });
    zone.addEventListener('dragleave', e => {
      if (!zone.contains(e.relatedTarget)) {
        zone.classList.remove('over');
        zone.closest('.day-col')?.classList.remove('drag-target');
      }
    });
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('over');
      zone.closest('.day-col')?.classList.remove('drag-target');
      if (!dragId) return;
      moveTour(dragId, zone.dataset.date, zone.dataset.status);
      dragId = null;
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
  if (targetStatus === 'done' && !tour.verladen_am) tour.verladen_am = new Date().toISOString().slice(0, 16);
  if (targetStatus === 'pending') tour.verladen_am = null;
  db.tours[currentNL][targetDate][targetStatus] = [...(db.tours[currentNL][targetDate][targetStatus] || []), tour];
  tour.updated = Date.now();
  scheduleSave(); render();
}

// ─── Niederlassung Management ─────────────────────────────────────────────────
function confirmAddNL() {
  const input = document.getElementById('nlNameInput');
  const name = input.value.trim();
  if (!name) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }
  if (db.niederlassungen.includes(name)) { toast('Niederlassung existiert bereits', 'error'); return; }
  db.niederlassungen.push(name);
  db.tours[name] = {};
  currentNL = name;
  input.value = '';
  closeModal('nlModal');
  scheduleSave(); render();
  toast(`Niederlassung „${name}" hinzugefügt`, 'success');
}

// ─── Search ───────────────────────────────────────────────────────────────────
function onSearchInput(e) { searchQuery = e.target.value; renderGrid(); }
function clearSearch() { searchQuery = ''; document.getElementById('searchInput').value = ''; renderGrid(); }

// ─── Dark Mode ────────────────────────────────────────────────────────────────
function toggleDarkMode() {
  isDark = !isDark;
  document.documentElement.classList.toggle('dark-mode', isDark);
  localStorage.setItem('darkMode', isDark ? '1' : '0');
  updateThemeUI();
}
function updateThemeUI() {
  const text = document.getElementById('themeSwitchText');
  const icon = document.getElementById('themeSwitchIcon');
  if (isDark) {
    if (text) text.textContent = 'Heller Modus';
    if (icon) icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  } else {
    if (text) text.textContent = 'Dunkler Modus';
    if (icon) icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  }
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id)?.classList.add('open');
  document.getElementById(id + '-backdrop')?.classList.add('open');
}
function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
  document.getElementById(id + '-backdrop')?.classList.remove('open');
}
function openFileMenu() { openModal('fileMenu'); }

// ─── Import ───────────────────────────────────────────────────────────────────
function openImportModal() {
  const sel = document.getElementById('importNlSelect');
  sel.innerHTML = db.niederlassungen.map(nl => `<option value="${escHtml(nl)}">${escHtml(nl)}</option>`).join('');
  sel.value = currentNL;
  openModal('importModal');
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
  closeModal('importModal');
  currentNL = nl;
  scheduleSave(); render();
  toast(`${added} Touren importiert`, 'success');
}

// ─── Export ───────────────────────────────────────────────────────────────────
function handleExport() {
  if (typeof XLSX === 'undefined') { toast('XLSX-Bibliothek nicht geladen', 'error'); return; }
  const wb = XLSX.utils.book_new();
  for (const nl of db.niederlassungen) {
    const rows = [['Datum', 'Wochentag', 'Name', 'Status', 'Absender', 'Empfänger',
      'Kommissionierliste', 'Gewicht (kg)', 'Ladebereit ab', 'Verladen am', 'Frachtpreis (€)', 'Besonderheiten']];
    for (const dateKey of Object.keys(db.tours[nl] || {}).sort()) {
      const day = db.tours[nl][dateKey];
      const d = parseDate(dateKey);
      const dayName = DAY_NAMES[((d.getDay() + 6) % 7)];
      const dateFormatted = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
      for (const [list, status] of [[(day.pending||[]), 'Ausstehend'], [(day.done||[]), 'Disponiert']]) {
        for (const t of list) {
          rows.push([dateFormatted, dayName, t.name, status,
            t.absender||'', t.empfaenger||'', t.kommissionierliste||'',
            t.gewicht||'', t.ladebereit_ab||'', t.verladen_am||'',
            t.frachtpreis||'', t.besonderheiten||'']);
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
  el.className = `toast-item ${type}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, 2800);
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['tourDetailModal','fileMenu','nlModal','importModal','importStatsModal'].forEach(id => closeModal(id));
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    document.getElementById('searchInput')?.focus();
  }
});
