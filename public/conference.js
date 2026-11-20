/* Conference persistence: every locked pin has a local journal and an idempotent cloud snapshot. */
const ROUNDS_KEY = 'rfds_pin_to_win_rounds_v2', CONFIG_KEY = 'rfds_pin_to_win_config_v2', DEVICE_KEY = 'rfds_pin_to_win_device_v1';
const BOARD_CACHE_KEYS = { 'all-time': 'rfds_pin_to_win_board_all_time_v1', today: 'rfds_pin_to_win_board_today_v1', teams: 'rfds_pin_to_win_board_teams_v1' };
function readStored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function writeStored(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { toast('Device backup could not save. Keep this game open.'); return false; } }
let conference = readStored(CONFIG_KEY, { timezone: 'Australia/Adelaide', eventId: 'rfds-conference' }), cloudAvailable = false, syncBusy = false;
// A random ID for this browser. Guests with the same name on the same device share one leaderboard identity.
const deviceId = (() => { let id = readStored(DEVICE_KEY, ''); if (!/^[0-9a-f-]{36}$/i.test(id)) { id = makeEoiClientId(); writeStored(DEVICE_KEY, id); } return id; })();
function conferenceDay(value = new Date()) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: conference.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)); const p = k => parts.find(x => x.type === k).value; return `${p('year')}-${p('month')}-${p('day')}`; }
async function gameRequest(action, body, timeout = 7000, query = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const params = new URLSearchParams({ action, ...query });
    const response = await fetch('/api/game?' + params, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) { const error = new Error(data.error || 'Cloud connection unavailable.'); error.setupRequired = !!data.setupRequired; error.status = response.status; error.field = data.field; throw error; }
    return data;
  } finally { clearTimeout(timer); }
}
function savedRounds() { const list = readStored(ROUNDS_KEY, []); return Array.isArray(list) ? list : []; }
function storeRound(record) {
  const records = savedRounds(), index = records.findIndex(r => r.id === record.id);
  if (index < 0) records.push(record);
  else { for (const key of ['hiddenAt', 'abandoned']) if (Object.prototype.hasOwnProperty.call(records[index], key)) record[key] = records[index][key]; records[index] = record; }
  writeStored(ROUNDS_KEY, records);
}
function persistProgress() {
  if (!state.session || (state.session.completed && state.flights.length < 3)) return;
  state.session.guesses = state.flights.map(f => ({ lat: f.guess.lat, lon: f.guess.lon, hint: !!f.hint }));
  state.session.score = state.score; state.session.completed = state.flights.length === 3; state.session.synced = false; state.session.updatedAt = new Date().toISOString();
  storeRound(state.session); syncPending();
}
// Returns '' when the game can start (online or offline), or a message if the server rejected the player's details.
async function beginSession() {
  const startedAt = new Date().toISOString(), originalId = state.roundId;
  let record = { id: originalId, name: state.player, email: state.email, organisation: state.organisation, deviceId, plan: state.plan.map(p => p.d.id), day: conferenceDay(startedAt), eventId: conference.eventId, timezone: conference.timezone, startedAt, updatedAt: startedAt, guesses: [], completed: false, synced: false, source: 'offline' };
  try {
    const data = await gameRequest('start', { id: originalId, name: state.player, email: state.email, organisation: state.organisation, deviceId, eventId: conference.eventId }, 3500);
    conference = { timezone: data.timezone, eventId: data.eventId }; writeStored(CONFIG_KEY, conference);
    record = { ...record, token: data.token, plan: data.plan, day: data.day, eventId: data.eventId, timezone: data.timezone, source: 'online', synced: true };
    state.plan = planFromIds(data.plan); cloudAvailable = true;
  } catch (error) {
    if (error.status === 400 && error.field) return error.message;
    // The first request may have reached the server even if its response was lost.
    // A fresh ID keeps the independent offline game from colliding with that empty session.
    record.id = makeEoiClientId(); state.roundId = record.id; cloudAvailable = false;
  }
  state.session = record; storeRound(record);
  return '';
}
async function syncPending() {
  if (syncBusy || !navigator.onLine) return; syncBusy = true;
  try {
    for (const snapshot of savedRounds().filter(r => !r.synced && r.eventId === conference.eventId && (r.token || r.completed)).slice(0, 20)) {
      try {
        const data = await gameRequest(snapshot.token ? 'progress' : 'recover', { ...snapshot }, 7000);
        const latest = savedRounds().find(r => r.id === snapshot.id);
        if (latest && latest.guesses.length === snapshot.guesses.length) {
          Object.assign(latest, { synced: true, day: data.day, lastError: '', ...(data.rank !== undefined ? { rank: data.rank } : {}), ...(data.review !== undefined ? { review: data.review } : {}) });
          storeRound(latest);
          if (state.session?.id === latest.id) { state.session = { ...latest }; window.renderSummaryRank?.(); }
        }
        cloudAvailable = true;
      } catch (error) {
        cloudAvailable = false; const latest = savedRounds().find(r => r.id === snapshot.id);
        if (latest) { latest.lastError = error.message; storeRound(latest); }
        if (!error.status || error.status >= 500 || error.status === 429) break;
      }
    }
  } finally { syncBusy = false; window.renderSummaryRank?.(); }
}
function saveCompletedScore() { persistProgress(); }

/* Leaderboards: All-time, Today and Teams. */
let boardScope = 'all-time', boardLoad = 0;
const BOARD_TEXT = {
  'all-time': { title: 'All-time high scores', stat: 'Top 20 · Best score per player' },
  today: { title: 'Today’s high scores', stat: 'Top 20 · Resets each conference day' },
  teams: { title: 'Team leaderboard', stat: 'Average of members’ best scores · 2+ players' }
};
function sortRows(rows) { return rows.sort((a, b) => b.score - a.score || (a.total_distance || 0) - (b.total_distance || 0) || String(a.startedAt || '').localeCompare(String(b.startedAt || '')) || String(a.id).localeCompare(String(b.id))); }
function localBoard(scope = 'all-time') {
  const today = conferenceDay();
  const rows = savedRounds().filter(r => r.completed && !r.hiddenAt && !r.review && r.eventId === conference.eventId && (scope !== 'today' || conferenceDay(r.startedAt) === today))
    .map(r => ({ id: r.id, name: r.name, score: r.score, total_distance: r.guesses.reduce((sum, g, i) => sum + haversineKm(g, REMOTE.find(d => d.id === r.plan[i])), 0), source: r.source, pending: !r.synced, local: true, startedAt: r.startedAt, playerKey: r.email ? r.email.toLowerCase() : RULES.nameKey(r.name) + '|' + (r.deviceId || r.id) }));
  const best = new Map(); for (const row of sortRows(rows)) if (!best.has(row.playerKey)) best.set(row.playerKey, row);
  return [...best.values()].slice(0, 20);
}
function renderBoard(rows, label, scope) {
  if (scope === 'teams') {
    $('board-rows').innerHTML = rows.length ? rows.map((r, i) => `<div class="board-row"><div class="rank">${i + 1}</div><div class="pilot">${escapeHtml(r.team)}<small>${Number(r.players).toLocaleString()} players · top score ${Number(r.top_score).toLocaleString()}</small></div><div class="score">${Number(r.average_score).toLocaleString()}</div></div>`).join('')
      : '<p class="board-empty">No teams yet. Add an organisation when you register; teams appear once two members have played.</p>';
  } else {
    $('board-rows').innerHTML = rows.length ? rows.map((r, i) => `<div class="board-row ${r.id === state.session?.id ? 'is-you' : ''}"><div class="rank">${i + 1}</div><div class="pilot">${escapeHtml(r.name)}<small>3 flights${r.pending ? ' · awaiting sync' : r.source === 'offline' ? ' · recovered offline' : ''}${r.id === state.session?.id ? ' · You' : ''}</small></div><div class="score">${Number(r.score).toLocaleString()}</div></div>`).join('')
      : `<p class="board-empty">${scope === 'today' ? 'No scores yet today. Set the first one.' : 'No scores yet. Set the first high score.'}</p>`;
  }
  $('board-sync-status').textContent = label;
  $('board-title').textContent = BOARD_TEXT[scope].title; $('board-event-stat').textContent = BOARD_TEXT[scope].stat;
  document.querySelectorAll('.board-tabs [role=tab]').forEach(tab => { const on = tab.dataset.scope === scope; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; });
}
async function populateBoard(scope = boardScope) {
  boardScope = scope; const request = ++boardLoad;
  const cache = readStored(BOARD_CACHE_KEYS[scope], null);
  const cacheOk = cache?.eventId === conference.eventId && (scope === 'all-time' ? cache.scope === 'all-time' : scope !== 'today' || cache.day === conferenceDay());
  const cached = cacheOk ? cache.rows : [];
  renderBoard(cached?.length ? cached : scope === 'teams' ? [] : localBoard(scope), 'Checking the cloud leaderboard…', scope);
  await syncPending();
  try {
    const data = await gameRequest('board', null, 7000, { scope }); if (request !== boardLoad) return;
    conference = { timezone: data.timezone, eventId: data.eventId }; writeStored(CONFIG_KEY, conference); cloudAvailable = true;
    if (scope === 'all-time' && data.scope !== 'all-time') throw new Error('All-time leaderboard update pending.');
    writeStored(BOARD_CACHE_KEYS[scope], { eventId: data.eventId, scope: data.scope, day: data.day || '', rows: data.rows });
    renderBoard(data.rows, 'Cloud leaderboard · refreshes automatically', scope);
    const pending = scope === 'teams' ? 0 : localBoard(scope).filter(r => r.pending).length;
    if (pending) $('board-sync-status').textContent += ` · ${pending} device score${pending === 1 ? '' : 's'} awaiting sync`;
  } catch (error) {
    if (request !== boardLoad) return; cloudAvailable = false;
    if (scope === 'teams') { renderBoard(cached || [], (error.setupRequired ? 'Team leaderboard setup is pending.' : 'Offline. The team leaderboard needs a connection.') + (cached?.length ? ' Showing the last synced teams.' : ''), scope); return; }
    renderBoard(cached?.length ? cached : localBoard(scope), (error.setupRequired ? 'Cloud setup pending. ' : 'Offline. ') + (cached?.length ? 'Showing the last synced board. ' : 'Showing this device’s scores. ') + 'New scores stay on this device until synced.', scope);
  }
}
document.querySelectorAll('.board-tabs [role=tab]').forEach((tab, i, tabs) => {
  tab.addEventListener('click', () => { populateBoard(tab.dataset.scope); track('ptw_board_view', { scope: tab.dataset.scope }); });
  tab.addEventListener('keydown', e => {
    const move = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!move) return; e.preventDefault();
    const next = tabs[(i + move + tabs.length) % tabs.length]; next.focus(); next.click();
  });
});

/* Where other players pinned a destination (online only, cached for the session). */
const crowdCache = new Map();
async function loadCrowd(destinationId) {
  if (!navigator.onLine) return null;
  if (crowdCache.has(destinationId)) return crowdCache.get(destinationId);
  try { const data = await gameRequest('crowd', null, 4000, { destination: destinationId }); crowdCache.set(destinationId, data.points || []); return data.points || []; }
  catch { return null; }
}

// Only entries with recorded contact consent are retried. Older unsynced entries stay in the device backup.
async function retryEois() { for (const entry of readStored(PIN_TO_WIN_EOI_KEY, []).filter(x => !x.synced && x.contactOptIn === true).slice(0, 20)) if (!await syncEoi(entry)) break; }

/* Resume: only recent, unfinished games on this device, so the next person at a kiosk isn't shown an old name. */
function resumableRecord() {
  const cutoff = Date.now() - CONFIG.resumeWindowMinutes * 60000;
  return savedRounds().filter(r => !r.completed && !r.abandoned && r.eventId === conference.eventId && (r.guesses?.length || 0) < 3 && Date.parse(r.updatedAt || r.startedAt) >= cutoff).at(-1);
}
function offerResume() {
  const record = resumableRecord();
  $('resume-panel').hidden = !record; if (!record) return;
  $('resume-label').textContent = `Unfinished game: ${record.name} · ${record.guesses.length} of 3 flights flown`;
  $('resume-btn').onclick = () => {
    const live = resumableRecord(); if (!live || live.id !== record.id) { offerResume(); return; }
    Object.assign(state, { session: record, roundId: record.id, player: record.name, email: record.email || '', organisation: record.organisation || '', plan: planFromIds(record.plan) });
    state.flights = record.guesses.map((guess, i) => { const d = state.plan[i].d, km = haversineKm(guess, d), p = scoreFor(km, guess.hint === true); return { destination: d.name, destinationId: d.id, state: d.state, distanceKm: km, score: p.total, base: p.base, bonus: p.bonus, penalty: p.penalty, hint: guess.hint === true, guess: { lat: guess.lat, lon: guess.lon, hint: guess.hint === true } }; });
    state.score = state.flights.reduce((sum, f) => sum + f.score, 0); state.currentIndex = state.flights.length;
    track('ptw_resume', { flights: state.flights.length });
    beginFlight();
  };
  $('discard-btn').onclick = () => {
    const records = savedRounds(), r = records.find(x => x.id === record.id);
    if (r) { r.abandoned = true; writeStored(ROUNDS_KEY, records); }
    offerResume(); $('open-start-btn').focus();
  };
}

window.addEventListener('online', () => { syncPending().then(() => { if (screens.board.classList.contains('active')) populateBoard(); }); retryEois(); });
setInterval(() => { if (screens.board.classList.contains('active')) populateBoard(); else syncPending(); }, 20000);
(async () => { try { const data = await gameRequest('config', null, 3500); conference = { timezone: data.timezone, eventId: data.eventId }; writeStored(CONFIG_KEY, conference); } catch { } offerResume(); syncPending(); retryEois(); })();

// Offline shell: lets the game reload on dropped conference Wi-Fi. Never caches /api or the admin pages.
if ('serviceWorker' in navigator && location.protocol === 'https:') window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { }));
