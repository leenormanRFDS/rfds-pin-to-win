/* RFDS Pin to Win — conference edition, v1.3 */

const RULES = window.PTW_RULES;
const CONFIG = Object.assign({ idleResetSeconds: 90, idleGameSeconds: 120, idleCountdownSeconds: 20, resumeWindowMinutes: 20 }, window.PTW_CONFIG || {});
const REMOTE = DESTINATIONS.filter(d => d.role === 'remote');
const BASES = DESTINATIONS.filter(d => d.role === 'base');
const MAP_BOUNDS = { minLon: 112, maxLon: 154, minLat: -44, maxLat: -10 };
const MAP_SVG = { w: 1120, h: 1029.4 };
const MAX_ZOOM = 8;
const TIER_LABELS = ['Warm-up', 'Standard', 'Remote'];
const svgNS = 'http://www.w3.org/2000/svg';
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const state = { email: '', player: '', organisation: '', contactOptIn: false, score: 0, flights: [], plan: [], currentIndex: 0, current: null, guess: null, hintUsed: false, dispatching: false, roundConfirmed: false, roundId: '', zoom: 1, panMode: false, revealing: false, session: null, revealFrame: 0 };

const $ = id => document.getElementById(id);
const screens = { start: $('screen-start'), game: $('screen-game'), result: $('screen-result'), summary: $('screen-summary'), board: $('screen-board') };
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m])); }
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(window.__rfdsToast); window.__rfdsToast = setTimeout(() => el.classList.remove('show'), 2200); }
function updateTop() { $('top-flights').textContent = `${state.flights.length} / 3`; $('top-score').textContent = state.score.toLocaleString(); }

/* Analytics: events go to dataLayer (GTM/GA4). Never send names or emails. */
window.dataLayer = window.dataLayer || [];
function track(event, params = {}) { try { window.dataLayer.push({ event, ...params }); } catch { } }
if (CONFIG.gtmId && /^GTM-[A-Z0-9]+$/.test(CONFIG.gtmId)) {
  window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
  const s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtm.js?id=' + CONFIG.gtmId; document.head.appendChild(s);
}

/* Contact consent. Only players who tick the box become entries. A local copy survives dropped Wi-Fi. */
const PIN_TO_WIN_EOI_KEY = 'rfds_pin_to_win_eois';
function makeEoiClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const bytes = new Uint8Array(16); if (window.crypto?.getRandomValues) crypto.getRandomValues(bytes); else bytes.forEach((_, i) => bytes[i] = Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128; const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function saveLocalEoi(record) {
  try {
    const stored = JSON.parse(localStorage.getItem(PIN_TO_WIN_EOI_KEY) || '[]');
    const list = Array.isArray(stored) ? stored : [];
    if (!list.some(x => x.clientId === record.clientId)) list.push(record);
    localStorage.setItem(PIN_TO_WIN_EOI_KEY, JSON.stringify(list.slice(-5000)));
    return true;
  } catch (err) { console.warn('Local entry backup failed:', err); return false; }
}
async function syncEoi(record) {
  try {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('/api/eoi', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(record), credentials: 'same-origin', signal: controller.signal });
    clearTimeout(timeout);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'Entry could not be saved to the server.');
    try {
      const stored = JSON.parse(localStorage.getItem(PIN_TO_WIN_EOI_KEY) || '[]');
      if (Array.isArray(stored)) localStorage.setItem(PIN_TO_WIN_EOI_KEY, JSON.stringify(stored.map(x => x.clientId === record.clientId ? Object.assign({}, x, { synced: true }) : x)));
    } catch { }
    return true;
  } catch (err) { console.warn('Entry sync pending; local backup retained:', err); return false; }
}
function captureContactConsent() {
  if (!state.contactOptIn || !state.email) return null;
  const record = { clientId: makeEoiClientId(), submittedAt: new Date().toISOString(), fullName: state.player, email: state.email, organisation: state.organisation, contactOptIn: true, website: $('player-website').value, sourceUrl: location.origin + location.pathname, synced: false };
  saveLocalEoi(record); syncEoi(record); track('ptw_contact_opt_in');
  return record;
}

function showScreen(k) {
  Object.entries(screens).forEach(([key, el]) => el.classList.toggle('active', key === k));
  document.body.dataset.screen = k;
  window.scrollTo?.(0, 0);
  if (k !== 'start') requestAnimationFrame(() => { const heading = screens[k].querySelector('h2,.result-title'); if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } });
  if (k === 'game') requestAnimationFrame(() => requestAnimationFrame(refreshMarkers));
}

/* The map uses the same projection as the RFDS Careers map. Affine fit from its node coordinates. */
const GEO_X = { a: -2735.18218625, b: 24.6920924, c: -0.04367975 };
const GEO_Y = { a: -223.34059445, b: -0.00419334, c: -27.1108143 };
function latLonToSvg(lat, lon) { return { x: GEO_X.a + GEO_X.b * lon + GEO_X.c * lat, y: GEO_Y.a + GEO_Y.b * lon + GEO_Y.c * lat }; }
const geoInv = (function () {
  const det = GEO_X.b * GEO_Y.c - GEO_X.c * GEO_Y.b;
  return { lonFrom: (x, y) => ((x - GEO_X.a) * GEO_Y.c - (y - GEO_Y.a) * GEO_X.c) / det, latFrom: (x, y) => (GEO_X.b * (y - GEO_Y.a) - GEO_Y.b * (x - GEO_X.a)) / det };
})();
function svgPointFromClient(svg, clientX, clientY) {
  const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
  const inv = svg.getScreenCTM()?.inverse(); if (!inv) return null;
  return pt.matrixTransform(inv);
}
const haversineKm = RULES.haversineKm;
const scoreFor = RULES.scoreFor;
function accuracyStatus(km) {
  if (km <= 10) return 'Precision navigation';
  if (km <= 25) return 'On course';
  if (km <= 50) return 'Good navigation';
  if (km <= 100) return 'In the area';
  if (km <= 250) return 'Course correction';
  return 'Off course';
}
function accuracyColour(km) { return km <= 25 ? '#59ddb2' : km <= 100 ? '#2dc995' : km <= 250 ? '#ffc568' : '#ff8068'; }
function accuracyPosition(km) {
  const stops = [[0, 1], [25, .8], [100, .55], [250, .25], [1000, 0]];
  if (km >= 1000) return 0;
  for (let i = 1; i < stops.length; i++) if (km <= stops[i][0]) { const [lo, lp] = stops[i - 1], [hi, hp] = stops[i]; return lp + (hp - lp) * (km - lo) / (hi - lo); }
  return 0;
}

/* Taskings. Game routes only: they illustrate the kinds of work the RFDS does, not specific operational legs. */
function scenarioFor(d) {
  if (d.state === 'NT') {
    const topEnd = d.base === 'Darwin';
    return { eyebrow: 'AEROMEDICAL // TASK RECEIVED', type: topEnd ? 'Remote community retrieval' : 'Remote patient transfer', vehicle: 'Pilatus PC-12', terrain: topEnd ? 'Top End community' : 'Central Australian country',
      copy: topEnd ? 'A request has come in from a remote Top End community. The crew is ready at Darwin and needs to locate the destination before departure.' : 'A patient in a remote Central Australian community needs transport so they can continue their care. The crew is tasked from Alice Springs.' };
  }
  if (d.section === 'SA_NT' && ['andamooka', 'marree'].includes(d.id)) return { eyebrow: 'BUSH RUN // TASK RECEIVED', type: 'Primary & allied health clinic', vehicle: 'Pilatus PC-12', terrain: 'Remote South Australian outback',
    copy: 'A scheduled Bush Run is heading into remote South Australia. A team of primary and allied health practitioners is travelling to run a clinic for the local community.' };
  if (d.section === 'VIC_TAS') {
    if (d.state === 'VIC') return { eyebrow: 'ROAD TASK // TASK RECEIVED', type: 'Road patient transport', vehicle: 'Patient transport ambulance', terrain: 'Regional Victoria', copy: 'A Patient Transport crew has a scheduled regional transfer. The patient is ready for collection and the crew needs to reach the correct destination.' };
    return { eyebrow: 'REGIONAL TASK // TASK RECEIVED', type: 'Regional transfer', vehicle: 'RFDS transfer aircraft', terrain: 'Bass Strait and Tasmania', copy: 'A regional transfer has been assigned across the southern network. Identify the destination before the leg begins.' };
  }
  if (d.section === 'WA') return { eyebrow: 'AEROMEDICAL // TASK RECEIVED', type: 'Patient retrieval', vehicle: 'Pilatus PC-12', terrain: 'Remote Western Australia', copy: 'A medical request has come from a remote community. The crew is tasked to retrieve the patient and connect them with further care.' };
  if (d.section === 'QLD') return { eyebrow: 'AEROMEDICAL // TASK RECEIVED', type: 'Patient transfer', vehicle: 'Pilatus PC-12', terrain: 'Queensland outback', copy: 'A patient needs transport from an outback community so they can continue their care. The crew is tasked and the destination must be located.' };
  return { eyebrow: 'AEROMEDICAL // TASK RECEIVED', type: 'Patient transfer', vehicle: 'Pilatus PC-12', terrain: 'Remote south-eastern country', copy: 'A patient transfer has been requested from a remote community. Navigate to the correct destination and connect the patient with further care.' };
}
function sectionLabel(s) { return ({ WA: 'Western Australia', SA_NT: 'South Australia / Northern Territory', QLD: 'Queensland', NSW_SE: 'New South Wales', VIC_TAS: 'Victoria / Tasmania' })[s] || s; }
const STATE_NAMES = { WA: 'Western Australia', NT: 'Northern Territory', QLD: 'Queensland', SA: 'South Australia', NSW: 'New South Wales', VIC: 'Victoria', TAS: 'Tasmania' };
function planFromIds(ids) {
  return ids.map(id => {
    const d = REMOTE.find(x => x.id === id); if (!d) throw new Error('Unknown saved destination.');
    return { destinationId: id, d, base: BASES.find(b => b.name === d.base) || BASES[0], scenario: scenarioFor(d) };
  });
}
// Offline fallback uses the same difficulty-balanced draw as the server.
function pickPlan() { return planFromIds(RULES.pickPlanIds(REMOTE, n => Math.floor(Math.random() * n))); }

/* SVG-native markers stay registered through zoom, pan, resize and rotation. */
const mapSvg = $('game-map-svg'), mapCanvas = $('map-canvas');
for (const [id, r, fill] of [['origin-dot', 6, '#f05b22'], ['guess-dot', 10, '#00b8e6'], ['actual-dot', 10, '#19a486']]) {
  const marker = document.createElementNS(svgNS, 'circle');
  marker.id = id; marker.setAttribute('r', r); marker.setAttribute('fill', fill); marker.setAttribute('stroke', '#fff'); marker.setAttribute('stroke-width', '2.5'); marker.setAttribute('vector-effect', 'non-scaling-stroke'); marker.style.display = 'none'; marker.style.pointerEvents = 'none'; mapSvg.appendChild(marker);
}
const halo = document.createElementNS(svgNS, 'circle'); halo.id = 'origin-halo'; halo.setAttribute('class', 'origin-halo'); halo.setAttribute('fill', 'none'); halo.setAttribute('stroke', '#f05b22'); halo.setAttribute('stroke-width', '2'); halo.setAttribute('vector-effect', 'non-scaling-stroke'); halo.style.display = 'none'; mapSvg.insertBefore(halo, $('origin-dot'));
const plane = document.createElementNS(svgNS, 'g'); plane.id = 'flight-plane'; plane.innerHTML = '<path d="M0 -12L3 -3L11 3L11 6L3 3L3 9L6 12L6 14L0 12L-6 14L-6 12L-3 9L-3 3L-11 6L-11 3L-3 -3Z" fill="#f05b22" stroke="#fff" stroke-width="1.2"/>'; plane.style.display = 'none'; plane.style.pointerEvents = 'none'; mapSvg.appendChild(plane);
const MARKER_RADIUS = { 'origin-dot': 5, 'guess-dot': 9, 'actual-dot': 9 };
function screenScale() { const m = mapSvg.getScreenCTM(); return m && m.a ? Math.abs(m.a) : 1; }
function setSvgCircle(el, lat, lon) {
  if (!el) return;
  const p = latLonToSvg(lat, lon), scale = screenScale();
  el.setAttribute('cx', p.x); el.setAttribute('cy', p.y); el.setAttribute('r', MARKER_RADIUS[el.id] / scale);
  if (el.id === 'origin-dot') { halo.setAttribute('cx', p.x); halo.setAttribute('cy', p.y); halo.setAttribute('r', 15 / scale); }
}
function refreshMarkers() {
  if (!state.current) return;
  setSvgCircle($('origin-dot'), state.current.base.lat, state.current.base.lon); $('origin-dot').style.display = 'block'; halo.style.display = 'block';
  if (state.guess) { setSvgCircle($('guess-dot'), state.guess.lat, state.guess.lon); $('guess-dot').style.display = 'block'; }
  if ($('actual-dot').style.display !== 'none') setSvgCircle($('actual-dot'), state.current.d.lat, state.current.d.lon);
}

/* Map view: zoom up to 8× so a fingertip can land within a few kilometres. */
let mapView = { x: 0, y: 0, w: MAP_SVG.w, h: MAP_SVG.h };
function applyMapView() {
  mapView.x = clamp(mapView.x, -30, MAP_SVG.w + 30 - mapView.w); mapView.y = clamp(mapView.y, -30, MAP_SVG.h + 30 - mapView.h);
  mapSvg.setAttribute('viewBox', `${mapView.x} ${mapView.y} ${mapView.w} ${mapView.h}`);
  const scale = screenScale();
  Object.entries(MARKER_RADIUS).forEach(([id, r]) => $(id).setAttribute('r', r / scale));
  halo.setAttribute('r', 15 / scale);
  $('zoom-in').disabled = state.revealing || state.zoom >= MAX_ZOOM; $('zoom-out').disabled = state.revealing || state.zoom <= 1;
  $('map-reset').disabled = state.revealing; $('pan-toggle').disabled = state.revealing;
}
function resetMap() {
  state.zoom = 1; state.panMode = false; mapView = { x: 0, y: 0, w: MAP_SVG.w, h: MAP_SVG.h }; applyMapView();
  $('pan-toggle').setAttribute('aria-pressed', 'false'); mapCanvas.classList.remove('pan-mode');
}
function zoomMap(direction) {
  const zoom = clamp(state.zoom * direction, 1, MAX_ZOOM), w = MAP_SVG.w / zoom, h = MAP_SVG.h / zoom;
  const pin = state.guess ? latLonToSvg(state.guess.lat, state.guess.lon) : null;
  const inView = pin && pin.x >= mapView.x && pin.x <= mapView.x + mapView.w && pin.y >= mapView.y && pin.y <= mapView.y + mapView.h;
  const centre = inView ? pin : { x: mapView.x + mapView.w / 2, y: mapView.y + mapView.h / 2 };
  mapView = { x: centre.x - w / 2, y: centre.y - h / 2, w, h }; state.zoom = zoom; applyMapView();
}

/* A flight */
function loadMission() {
  state.current = state.plan[state.currentIndex]; state.guess = null; state.hintUsed = false; state.roundConfirmed = false; state.revealing = false;
  cancelAnimationFrame(state.revealFrame);
  $('reveal-panel').hidden = true; $('reveal-continue').hidden = true;
  $('task-panel').classList.remove('is-revealing'); mapCanvas.inert = false; resetMap(); plane.style.display = 'none'; hideLoupe();
  const d = state.current.d, s = state.current.scenario;
  $('task-number').textContent = String(state.currentIndex + 1);
  $('task-tier').textContent = TIER_LABELS[state.currentIndex] || '';
  $('task-question-big').textContent = d.name;
  $('task-region').textContent = STATE_NAMES[d.state] || sectionLabel(d.section);
  $('map-section-pill').textContent = d.state;
  $('task-base').textContent = state.current.base.name; $('map-base-name').textContent = state.current.base.name;
  $('task-type').textContent = s.type; $('task-vehicle').textContent = s.vehicle;
  $('pin-status').textContent = 'Place a pin to continue.';
  $('map-hint').textContent = matchMedia('(pointer: coarse)').matches ? 'Tap to pin · drag to refine · pinch to zoom' : 'Click the map to place your pin · use + to zoom in';
  [...$('flight-steps').children].forEach((el, i) => { el.className = i < state.currentIndex ? 'done' : i === state.currentIndex ? 'current' : ''; });
  $('hint-btn').disabled = false; $('hint-btn').classList.remove('used'); $('hint-btn').querySelector('span').textContent = 'Need a hint? Show the area'; $('hint-cost').textContent = `−${RULES.HINT_PENALTY} pts`;
  $('hint-zone').style.display = 'none';
  $('guess-dot').style.display = 'none'; $('actual-dot').style.display = 'none'; $('route-path').setAttribute('d', '');
  $('confirm-btn').disabled = true;
  document.querySelectorAll('.map-controls button').forEach(el => el.disabled = false); applyMapView();
  requestAnimationFrame(refreshMarkers);
  updateTop();
}
// Load a flight, show the map and then the tasking briefing over it.
function beginFlight() { loadMission(); showScreen('game'); showBriefing(); }

/* Tasking briefing: a short, skippable radio-style card before each flight. */
let briefingTimer = 0;
function showBriefing() {
  const overlay = $('dispatch-overlay'), s = state.current.scenario;
  $('dispatch-kicker').textContent = s.eyebrow || 'RFDS OPERATIONS // TASK RECEIVED';
  $('dispatch-type').textContent = s.type;
  $('dispatch-copy').textContent = s.copy;
  $('dispatch-flight').textContent = `${state.currentIndex + 1} of 3 · ${TIER_LABELS[state.currentIndex] || ''}`;
  $('dispatch-base').textContent = state.current.base.name;
  $('dispatch-vehicle').textContent = s.vehicle;
  overlay.classList.remove('animate'); void overlay.offsetWidth; if (!reducedMotion()) overlay.classList.add('animate');
  overlay.classList.add('open'); overlay.setAttribute('aria-hidden', 'false'); setInert(true, overlay);
  $('dispatch-go').focus({ preventScroll: true });
  clearTimeout(briefingTimer); briefingTimer = setTimeout(closeBriefing, 4200);
}
function closeBriefing() {
  clearTimeout(briefingTimer);
  const overlay = $('dispatch-overlay'); if (!overlay.classList.contains('open')) return;
  overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); setInert(false);
  state.dispatching = false;
  requestAnimationFrame(refreshMarkers); mapCanvas.focus({ preventScroll: true });
}
$('dispatch-go').addEventListener('click', closeBriefing);
$('dispatch-overlay').addEventListener('click', e => { if (e.target === $('dispatch-overlay')) closeBriefing(); });

/* Modals: one implementation for registration, leave and idle dialogs. */
// While one overlay is open, everything else on the page is inert. `except` is the open overlay.
function setInert(on, except) {
  document.querySelectorAll('.screen,.topbar,.modal-shell,.dispatch-overlay').forEach(el => { el.inert = on && el !== except; });
}
function openModal(id, focusId) {
  const modal = $(id); modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); setInert(true, modal);
  requestAnimationFrame(() => (focusId ? $(focusId) : modal.querySelector('button,input'))?.focus());
}
function closeModal(id, returnFocus) {
  const modal = $(id); if (!modal.classList.contains('open')) return;
  modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); setInert(false);
  returnFocus?.focus?.();
}
document.querySelectorAll('.modal-shell').forEach(modal => modal.addEventListener('keydown', e => {
  if (e.key === 'Escape' && modal.id !== 'idle-modal') { e.preventDefault(); modal.id === 'registration-modal' ? closeRegistration() : closeModal(modal.id); }
  if (e.key === 'Tab') {
    const items = [...modal.querySelectorAll('button,input,a[href]')].filter(el => !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null);
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}));

/* Registration */
if (CONFIG.privacyUrl && /^https:\/\//.test(CONFIG.privacyUrl)) {
  const link = document.createElement('a'); link.href = CONFIG.privacyUrl; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Read the RFDS privacy policy';
  $('collection-notice').append(' ', link, '.');
}
function openRegistration() { $('registration-error').textContent = ''; openModal('registration-modal', 'player-name'); }
function closeRegistration() { closeModal('registration-modal', $('open-start-btn')); }
function fieldError(id, message) { $('registration-error').textContent = message; $(id).setAttribute('aria-invalid', 'true'); $(id).focus(); }
async function startGame() {
  if (state.dispatching) return;
  $('registration-error').textContent = '';
  ['player-name', 'player-email', 'player-org'].forEach(id => $(id).removeAttribute('aria-invalid'));
  const name = RULES.normaliseName($('player-name').value).slice(0, 40);
  const email = ($('player-email').value || '').trim().slice(0, 120);
  const organisation = RULES.normaliseName($('player-org').value).slice(0, 40);
  const contact = $('player-contact').checked;
  const nameProblem = RULES.nameProblem(name);
  if (nameProblem) return fieldError('player-name', nameProblem);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fieldError('player-email', 'Enter a valid email address, such as you@example.com.');
  if (contact && !email) return fieldError('player-email', 'Add your email so the RFDS can contact you, or untick the box.');
  if (organisation && RULES.nameProblem(organisation)) return fieldError('player-org', 'Please choose a different organisation name.');
  state.dispatching = true; $('start-btn').disabled = true; $('start-btn').textContent = 'Preparing your flight…';
  Object.assign(state, { player: name, email, organisation, contactOptIn: contact, score: 0, flights: [], currentIndex: 0, plan: pickPlan(), roundId: makeEoiClientId() });
  try {
    const serverProblem = await beginSession();
    if (serverProblem) { state.dispatching = false; return fieldError('player-name', serverProblem); }
    captureContactConsent();
  } finally { $('start-btn').disabled = false; $('start-btn').innerHTML = 'Let’s fly <span aria-hidden="true">→</span>'; }
  track('ptw_start', { mode: state.session?.source || 'offline', has_email: !!email, has_team: !!organisation });
  closeModal('registration-modal');
  beginFlight();
}

/* Placing the pin. On touch, a magnifier above the finger shows exactly where the pin sits. */
const loupe = $('loupe'), loupeSvg = $('loupe-svg');
function showLoupe(clientX, clientY) {
  if (!state.guess) return;
  const rect = mapCanvas.getBoundingClientRect(), size = 132;
  let left = clientX - rect.left - size / 2, top = clientY - rect.top - size - 56;
  if (top < 4) top = clientY - rect.top + 56;
  left = clamp(left, 4, rect.width - size - 4);
  loupe.style.transform = `translate(${left}px,${top}px)`;
  const p = latLonToSvg(state.guess.lat, state.guess.lon), span = Math.max(10, mapView.w / 4.5);
  loupeSvg.setAttribute('viewBox', `${p.x - span / 2} ${p.y - span / 2} ${span} ${span}`);
  const pin = $('loupe-pin'); pin.setAttribute('cx', p.x); pin.setAttribute('cy', p.y); pin.setAttribute('r', span / 26);
  const o = latLonToSvg(state.current.base.lat, state.current.base.lon), origin = $('loupe-origin'); origin.setAttribute('cx', o.x); origin.setAttribute('cy', o.y); origin.setAttribute('r', span / 34);
  loupe.hidden = false;
}
function hideLoupe() { loupe.hidden = true; }
function setGuessFromPointer(e, { drop = false } = {}) {
  const p = svgPointFromClient(mapSvg, e.clientX, e.clientY); if (!p) return;
  if (p.x < 0 || p.x > MAP_SVG.w || p.y < 0 || p.y > MAP_SVG.h) return;
  const lon = geoInv.lonFrom(p.x, p.y), lat = geoInv.latFrom(p.x, p.y);
  if (lon < MAP_BOUNDS.minLon - 2 || lon > MAP_BOUNDS.maxLon + 2 || lat < MAP_BOUNDS.minLat - 2 || lat > MAP_BOUNDS.maxLat + 2) return;
  if (state.roundConfirmed) return;
  const first = !state.guess;
  state.guess = { lat, lon };
  const dot = $('guess-dot'); setSvgCircle(dot, lat, lon); dot.style.display = 'block';
  if ((first || drop) && !reducedMotion()) { dot.classList.remove('drop'); void dot.getBBox(); dot.classList.add('drop'); }
  $('map-hint').textContent = 'Pin placed — zoom in to refine, then lock it in';
  $('confirm-btn').disabled = false;
  $('pin-status').textContent = 'Pin placed. Ready when you are.';
}

/* Hint: shade a 300 km area that contains the destination (not centred on it). Costs points. */
function useHint() {
  if (state.hintUsed || state.roundConfirmed || !state.current) return;
  state.hintUsed = true;
  const d = state.current.d, radius = RULES.HINT_RADIUS_KM, bearing = Math.random() * 2 * Math.PI, offset = radius * (.25 + Math.random() * .45);
  const dLat = offset * Math.cos(bearing) / 111.32, dLon = offset * Math.sin(bearing) / (111.32 * Math.cos(d.lat * Math.PI / 180));
  const centre = { lat: d.lat + dLat, lon: d.lon + dLon }, c = latLonToSvg(centre.lat, centre.lon);
  const east = latLonToSvg(centre.lat, centre.lon + radius / (111.32 * Math.cos(centre.lat * Math.PI / 180))), north = latLonToSvg(centre.lat + radius / 111.32, centre.lon);
  const zone = $('hint-zone'); zone.setAttribute('cx', c.x); zone.setAttribute('cy', c.y); zone.setAttribute('rx', Math.abs(east.x - c.x)); zone.setAttribute('ry', Math.abs(north.y - c.y)); zone.style.display = 'block';
  $('hint-btn').disabled = true; $('hint-btn').classList.add('used'); $('hint-btn').querySelector('span').textContent = 'Hint used · search the shaded area';
  track('ptw_hint_used', { flight: state.currentIndex + 1 });
}
$('hint-btn').addEventListener('click', useHint);

function animateNumber(el, from, to, duration = 250, prefix = '') {
  duration = reducedMotion() ? 0 : Math.min(duration, 900); const start = performance.now();
  function tick(now) { const p = duration === 0 ? 1 : Math.min(1, (now - start) / duration), e = 1 - Math.pow(1 - p, 3), v = Math.round(from + (to - from) * e); el.textContent = prefix + v.toLocaleString(); if (p < 1) requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
}

function confirmGuess() {
  if (!state.guess || !state.current || state.roundConfirmed) return;
  state.roundConfirmed = true; state.revealing = true; hideLoupe();
  const d = state.current.d, dist = haversineKm(state.guess, d), scoring = scoreFor(dist, state.hintUsed), priorTotal = state.score;
  state.score += scoring.total;
  state.flights.push({ destination: d.name, destinationId: d.id, state: d.state, distanceKm: dist, score: scoring.total, base: scoring.base, bonus: scoring.bonus, penalty: scoring.penalty, hint: state.hintUsed, guess: { ...state.guess, hint: state.hintUsed } });
  persistProgress(); // Save first; the animation never controls whether a flight survives.
  resetMap(); setSvgCircle($('guess-dot'), state.guess.lat, state.guess.lon);
  $('task-panel').classList.add('is-revealing'); $('reveal-panel').hidden = false; mapCanvas.inert = true;
  document.querySelectorAll('.map-controls button').forEach(el => el.disabled = true); $('confirm-btn').disabled = true; $('hint-btn').disabled = true;
  $('reveal-phase').textContent = 'Pin locked'; $('reveal-km').textContent = '—'; $('reveal-caption').textContent = 'Your location is locked in.'; $('map-hint').textContent = 'Flight plan confirmed';
  const origin = latLonToSvg(state.current.base.lat, state.current.base.lon), guess = latLonToSvg(state.guess.lat, state.guess.lon);
  const control = { x: (origin.x + guess.x) / 2, y: Math.min(origin.y, guess.y) - Math.min(120, Math.abs(origin.x - guess.x) * .12 + 35) };
  const path = $('route-path'); path.setAttribute('d', `M ${origin.x} ${origin.y} Q ${control.x} ${control.y} ${guess.x} ${guess.y}`);
  const pathLength = path.getTotalLength(); path.style.strokeDasharray = String(pathLength); path.style.strokeDashoffset = String(pathLength);
  const reduced = reducedMotion(); let previousPhase = -1, shownTarget = false;
  const start = performance.now(), duration = reduced ? 900 : 6200, maxKm = Math.max(3000, Math.ceil(dist / 500) * 500 + 500);
  function tick(now) {
    if (!state.revealing) return;
    const elapsed = Math.min(6200, (now - start) / duration * 6200), phase = elapsed < 500 ? 0 : elapsed < 2000 ? 1 : elapsed < 4700 ? 2 : 3;
    if (phase !== previousPhase) { previousPhase = phase; $('reveal-phase').textContent = ['Pin locked', 'Flight underway', 'Revealing your accuracy', 'Destination located'][phase]; $('reveal-caption').textContent = ['Flight plan confirmed.', 'Following the route to your pin.', 'Distance reveal · final reading locks at the end.', ''][phase]; }
    const flightP = clamp((elapsed - 500) / 1500, 0, 1), q = path.getPointAtLength(pathLength * flightP), next = path.getPointAtLength(Math.min(pathLength, pathLength * flightP + 1));
    if (!reduced) { plane.style.display = phase === 1 ? 'block' : 'none'; plane.setAttribute('transform', `translate(${q.x} ${q.y}) rotate(${Math.atan2(next.y - q.y, next.x - q.x) * 180 / Math.PI + 90}) scale(${1 / screenScale()})`); path.style.strokeDashoffset = String(pathLength * (1 - flightP)); }
    if (phase >= 2) { const p = clamp((elapsed - 2000) / 2700, 0, 1), eased = 1 - Math.pow(1 - p, 3), km = maxKm + (dist - maxKm) * eased; $('reveal-km').textContent = p >= 1 ? dist.toFixed(1) : Math.round(km).toLocaleString(); $('proximity-pointer').style.left = `${accuracyPosition(km) * 100}%`; $('proximity-pointer').style.background = accuracyColour(km); }
    if (phase === 3 && !shownTarget) { shownTarget = true; path.style.strokeDasharray = ''; path.style.strokeDashoffset = ''; setSvgCircle($('actual-dot'), d.lat, d.lon); $('actual-dot').style.display = 'block'; $('reveal-caption').textContent = accuracyStatus(dist) + ' · +' + scoring.total.toLocaleString() + ' points'; $('reveal-continue').hidden = false; $('reveal-continue').onclick = finish; $('map-hint').textContent = `Your pin is ${dist.toFixed(1)} km from ${d.name}`; }
    if (elapsed >= 6200) { finish(); return; } state.revealFrame = requestAnimationFrame(tick);
  }
  function finish() {
    if (!state.revealing) return; state.revealing = false; cancelAnimationFrame(state.revealFrame); plane.style.display = 'none'; path.style.strokeDasharray = ''; path.style.strokeDashoffset = '';
    showFlightResult(d, dist, scoring, priorTotal);
  }
  state.revealFrame = requestAnimationFrame(tick);
}

/* Flight result */
function showFlightResult(d, dist, scoring, priorTotal) {
  const status = accuracyStatus(dist), flight = state.flights[state.currentIndex];
  $('result-destination').innerHTML = `${escapeHtml(d.name)}<span>, ${escapeHtml(d.state)}</span>`;
  $('result-flight-label').textContent = `Flight ${state.currentIndex + 1} of 3`;
  $('next-btn').innerHTML = state.currentIndex === 2 ? 'See mission summary <span aria-hidden="true">→</span>' : 'Next flight <span aria-hidden="true">→</span>';
  $('result-feedback').textContent = dist <= 25 ? 'Precision pin. Beautiful navigation.' : dist <= 100 ? 'On course. A well-placed pin.' : dist <= 250 ? 'Close. Keep refining your navigation.' : 'A little off course. Every flight is a fresh start.';
  $('result-feedback').style.color = accuracyColour(dist);
  $('result-distance').textContent = `${dist.toFixed(1)} km`; $('accuracy-status').textContent = status;
  $('result-breakdown').textContent = `Base ${scoring.base.toLocaleString()} + precision bonus ${scoring.bonus.toLocaleString()}` + (scoring.penalty ? ` − hint ${scoring.penalty}` : '');
  animateNumber($('result-score'), 0, scoring.total, 700, '+'); animateNumber($('result-total'), priorTotal, state.score, 900);
  const streak = RULES.streakFor(state.flights);
  $('result-streak').hidden = streak < 2; $('result-streak').textContent = streak >= 2 ? `${streak} flights in a row within 100 km` : '';
  $('result-fact').hidden = !d.fact; $('result-fact').textContent = d.fact || '';
  renderResultMap();
  $('crowd-line').textContent = ''; $('legend-crowd').hidden = true;
  loadCrowd(d.id).then(points => { if (points && screens.result.classList.contains('active') && state.current?.d.id === d.id) showCrowd(points, flight); });
  track('ptw_flight_complete', { flight: state.currentIndex + 1, distance_km: Math.round(dist), points: scoring.total, hint: !!flight.hint, difficulty: d.difficulty });
  updateTop(); showScreen('result');
}
// Frame the pin and the destination together so a 20 km miss is still visible.
function renderResultMap() {
  const a = latLonToSvg(state.guess.lat, state.guess.lon), b = latLonToSvg(state.current.d.lat, state.current.d.lon), aspect = 1.5;
  const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
  let h = Math.max(dy * 2.2, dx * 2.2 / aspect, 40); h = Math.min(h, MAP_SVG.h); const w = Math.min(h * aspect, MAP_SVG.w + 200);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `${cx - w / 2} ${cy - h / 2} ${w} ${h}`); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Your pin and ${state.current.d.name}, ${haversineKm(state.guess, state.current.d).toFixed(1)} km apart`);
  // The destination is a ring and the pin a dot, so both stay visible when they nearly overlap.
  const r = h / 40;
  svg.innerHTML = `<use href="#geo-australia" class="result-land" stroke-width="${h / 260}"></use><g id="result-crowd"></g>
    <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="result-line" stroke-width="${r / 3}" stroke-dasharray="${r} ${r * .8}"></line>
    <circle cx="${b.x}" cy="${b.y}" r="${r * 1.7}" class="result-target" stroke-width="${r * .7}"></circle>
    <circle cx="${a.x}" cy="${a.y}" r="${r}" class="result-pin" stroke-width="${r / 3}"></circle>`;
  svg.dataset.r = r;
  $('result-map').replaceChildren(svg);
}
function showCrowd(points, flight) {
  const d = state.current.d, mine = { lat: Math.round(flight.guess.lat * 100) / 100, lon: Math.round(flight.guess.lon * 100) / 100 };
  let removedSelf = false;
  const others = points.filter(p => { if (!removedSelf && p.lat === mine.lat && p.lon === mine.lon) { removedSelf = true; return false; } return true; });
  const group = $('result-map').querySelector('#result-crowd'), r = Number($('result-map').querySelector('svg')?.dataset.r || 10) / 2.6;
  if (group) group.innerHTML = others.slice(0, 300).map(p => { const s = latLonToSvg(p.lat, p.lon); return `<circle cx="${s.x}" cy="${s.y}" r="${r}" class="result-crowd-dot"></circle>`; }).join('');
  $('legend-crowd').hidden = !others.length;
  if (others.length < 3) { $('crowd-line').textContent = others.length ? 'You’re one of the first pilots to fly this tasking.' : 'You’re the first pilot to fly this tasking.'; return; }
  const km = others.map(p => haversineKm(p, d)).sort((x, y) => x - y), median = km[Math.floor(km.length / 2)];
  const beaten = km.filter(k => k > flight.distanceKm).length, pct = Math.round(beaten / km.length * 100);
  $('crowd-line').textContent = `Closer than ${pct}% of ${km.length.toLocaleString()} pilots on ${d.name}. The typical pin was ${Math.round(median).toLocaleString()} km off.`;
}
function nextFlight() {
  if (!state.roundConfirmed || state.revealing) return;
  if (state.currentIndex >= state.plan.length - 1) { saveCompletedScore(); showSummary(); return; }
  state.currentIndex++; beginFlight();
}

/* Mission summary: final score, rank title, badges and leaderboard position. */
function showSummary() {
  const rank = RULES.rankFor(state.score), badges = RULES.badgesFor(state.flights);
  $('summary-name').textContent = state.player;
  $('summary-title').textContent = rank.title;
  animateNumber($('summary-score'), 0, state.score, 900);
  $('summary-next-rank').textContent = rank.next ? `${rank.next.needed.toLocaleString()} more points to reach ${rank.next.title}.` : 'The top rank in the challenge.';
  $('summary-flights').innerHTML = state.flights.map((f, i) => `<li><span class="sf-num">${i + 1}</span><div><strong>${escapeHtml(f.destination)}, ${escapeHtml(f.state || '')}</strong><small>${f.distanceKm.toFixed(1)} km off · ${accuracyStatus(f.distanceKm)}${f.hint ? ' · hint used' : ''}</small></div><b>+${f.score.toLocaleString()}</b></li>`).join('');
  $('summary-badges').innerHTML = badges.length ? badges.map(b => `<span class="badge" title="${escapeHtml(b.detail)}"><b>${escapeHtml(b.title)}</b><small>${escapeHtml(b.detail)}</small></span>`).join('') : '<p class="badge-empty">No badges this time. Try for a pin within 25 km.</p>';
  const cta = CONFIG.ctaUrl && /^https:\/\//.test(CONFIG.ctaUrl);
  $('summary-cta').hidden = !cta;
  if (cta) { $('summary-cta-copy').textContent = CONFIG.ctaCopy || ''; $('summary-cta-link').textContent = CONFIG.ctaLabel || 'Support the Flying Doctor'; $('summary-cta-link').href = CONFIG.ctaUrl; }
  renderSummaryRank();
  track('ptw_game_complete', { score: state.score, rank_title: rank.title, badges: badges.map(b => b.id).join(','), hints: state.flights.filter(f => f.hint).length });
  updateTop(); showScreen('summary');
}
function renderSummaryRank() {
  const el = $('summary-rank'), s = state.session; if (!el || !s) return;
  if (s.review) { el.textContent = 'Great flying. Your score is with staff for a quick check before it appears on the leaderboard.'; return; }
  if (!s.synced) { el.textContent = navigator.onLine && s.token ? 'Saving your score to the leaderboard…' : 'Saved on this device. Your score joins the leaderboard when the device reconnects.'; return; }
  const a = s.rank?.allTime, t = s.rank?.today;
  if (!a) { el.textContent = 'Your score is on the leaderboard.'; return; }
  const pilots = n => `${n.toLocaleString()} pilot${n === 1 ? '' : 's'}`;
  const parts = [`<strong>#${a.rank.toLocaleString()}</strong> of ${pilots(a.total)} all-time`];
  if (t) parts.push(`<strong>#${t.rank.toLocaleString()}</strong> of ${pilots(t.total)} today`);
  let html = parts.join(' · ');
  if (a.bestScore != null && a.bestScore > state.score) html += `<small>Your best is still ${a.bestScore.toLocaleString()}.</small>`;
  else if (a.rank <= 20) html += '<small>You’re on the top-20 board.</small>';
  el.innerHTML = html;
}
window.renderSummaryRank = renderSummaryRank;

/* Touch/mouse interaction */
const mapPointers = new Map(); let drag = null, pinch = null, multiTouch = false, touchStart = null;
function touchPoints() { return [...mapPointers.values()]; }
function beginPinch() {
  const [a, b] = touchPoints(); if (!a || !b) return;
  const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  pinch = { centre, anchor: svgPointFromClient(mapSvg, centre.x, centre.y), distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), view: { ...mapView }, zoom: state.zoom, scale: screenScale() };
  multiTouch = true; drag = null; hideLoupe();
  // A second finger begins a map gesture; it never leaves a new accidental pin.
  if (touchStart) {
    state.guess = touchStart.guess;
    if (state.guess) { setSvgCircle($('guess-dot'), state.guess.lat, state.guess.lon); $('guess-dot').style.display = 'block'; }
    else { $('guess-dot').style.display = 'none'; $('confirm-btn').disabled = true; $('pin-status').textContent = 'Place a pin to continue.'; }
  }
}
mapCanvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || state.revealing) return; e.preventDefault(); mapCanvas.focus({ preventScroll: true }); mapCanvas.setPointerCapture?.(e.pointerId);
  mapPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (mapPointers.size > 1) { beginPinch(); return; }
  touchStart = { x: e.clientX, y: e.clientY, guess: state.guess ? { ...state.guess } : null };
  if (state.panMode) drag = { p: svgPointFromClient(mapSvg, e.clientX, e.clientY) };
  else if (e.pointerType !== 'touch') setGuessFromPointer(e, { drop: true });
});
mapCanvas.addEventListener('pointermove', e => {
  if (!mapPointers.has(e.pointerId) || state.revealing) return;
  mapPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && mapPointers.size >= 2) {
    const [a, b] = touchPoints(), centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const zoom = clamp(pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance, 1, MAX_ZOOM), ratio = (MAP_SVG.w / zoom) / pinch.view.w;
    mapView = { x: pinch.anchor.x - (pinch.anchor.x - pinch.view.x) * ratio - (centre.x - pinch.centre.x) / pinch.scale * ratio, y: pinch.anchor.y - (pinch.anchor.y - pinch.view.y) * ratio - (centre.y - pinch.centre.y) / pinch.scale * ratio, w: MAP_SVG.w / zoom, h: MAP_SVG.h / zoom }; state.zoom = zoom; applyMapView(); return;
  }
  if (multiTouch) return;
  if (state.panMode && drag) { const p = svgPointFromClient(mapSvg, e.clientX, e.clientY); mapView.x += drag.p.x - p.x; mapView.y += drag.p.y - p.y; applyMapView(); }
  else if (e.pointerType !== 'touch') { if (e.buttons) setGuessFromPointer(e); }
  else if (Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y) > 5) { setGuessFromPointer(e); showLoupe(e.clientX, e.clientY); }
});
function finishMapPointer(e) {
  if (!mapPointers.has(e.pointerId)) return;
  if (e.type === 'pointerup' && e.pointerType === 'touch' && !multiTouch && !state.panMode && !state.revealing) setGuessFromPointer(e, { drop: loupe.hidden });
  mapPointers.delete(e.pointerId);
  if (mapPointers.size === 0) { drag = null; pinch = null; multiTouch = false; touchStart = null; hideLoupe(); }
}
mapCanvas.addEventListener('pointerup', finishMapPointer); mapCanvas.addEventListener('pointercancel', finishMapPointer); mapCanvas.addEventListener('lostpointercapture', finishMapPointer);
mapCanvas.addEventListener('keydown', e => {
  if (state.revealing) { e.preventDefault(); return; }
  if (['+', '=', '-', 'Home'].includes(e.key)) { e.preventDefault(); e.key === 'Home' ? resetMap() : zoomMap(e.key === '-' ? 1 / 1.6 : 1.6); return; }
  const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }; if (!moves[e.key] || state.roundConfirmed) return; e.preventDefault();
  const p = state.guess ? latLonToSvg(state.guess.lat, state.guess.lon) : { x: mapView.x + mapView.w / 2, y: mapView.y + mapView.h / 2 };
  const step = (e.shiftKey ? 2 : 12) / state.zoom, delta = moves[e.key], point = mapSvg.createSVGPoint();
  point.x = clamp(p.x + delta[0] * step, 0, MAP_SVG.w); point.y = clamp(p.y + delta[1] * step, 0, MAP_SVG.h);
  const client = point.matrixTransform(mapSvg.getScreenCTM()); setGuessFromPointer({ clientX: client.x, clientY: client.y });
});
$('zoom-in').addEventListener('click', () => zoomMap(1.6)); $('zoom-out').addEventListener('click', () => zoomMap(1 / 1.6)); $('map-reset').addEventListener('click', resetMap);
$('pan-toggle').addEventListener('click', () => { if (state.revealing) return; state.panMode = !state.panMode; $('pan-toggle').setAttribute('aria-pressed', String(state.panMode)); mapCanvas.classList.toggle('pan-mode', state.panMode); $('map-hint').textContent = state.panMode ? 'Drag to move the map. Switch off Move map to place a pin.' : state.guess ? 'Pin placed — zoom in to refine, then lock it in' : 'Tap the map to place your pin'; });

/* Navigation */
$('open-start-btn').addEventListener('click', openRegistration);
$('registration-form').addEventListener('submit', e => { e.preventDefault(); startGame(); });
$('registration-close').addEventListener('click', closeRegistration);
$('registration-modal').addEventListener('click', e => { if (e.target.id === 'registration-modal') closeRegistration(); });
$('confirm-btn').addEventListener('click', confirmGuess);
$('next-btn').addEventListener('click', nextFlight);
$('start-board-btn').addEventListener('click', () => openBoard('all-time'));
$('summary-board-btn').addEventListener('click', () => openBoard('all-time'));
function openBoard(scope) { populateBoard(scope); showScreen('board'); track('ptw_board_view', { scope }); }

function returnToHome() {
  state.revealing = false; cancelAnimationFrame(state.revealFrame); clearTimeout(briefingTimer);
  if (state.session && !state.session.completed) persistProgress();
  Object.assign(state, { session: null, score: 0, flights: [], currentIndex: 0, current: null, guess: null, hintUsed: false, dispatching: false, player: '', email: '', organisation: '', contactOptIn: false });
  ['player-name', 'player-email', 'player-org', 'player-website'].forEach(id => { $(id).value = ''; $(id).removeAttribute('aria-invalid'); });
  $('player-contact').checked = false; $('registration-error').textContent = '';
  ['registration-modal', 'leave-modal', 'idle-modal'].forEach(id => closeModal(id));
  $('dispatch-overlay').classList.remove('open'); setInert(false);
  ['guess-dot', 'actual-dot', 'origin-dot'].forEach(id => $(id).style.display = 'none'); halo.style.display = 'none'; hideLoupe();
  $('route-path').setAttribute('d', ''); $('hint-zone').style.display = 'none'; $('confirm-btn').disabled = true;
  updateTop(); showScreen('start'); offerResume();
  $('open-start-btn').focus();
}
$('board-home-btn').addEventListener('click', returnToHome);
$('board-home-footer-btn').addEventListener('click', returnToHome);
$('summary-home-btn').addEventListener('click', returnToHome);
$('brand-badge').addEventListener('click', () => {
  const midGame = (screens.game.classList.contains('active') || screens.result.classList.contains('active')) && state.session && state.flights.length < 3;
  if (midGame) openModal('leave-modal', 'leave-cancel'); else if (!screens.start.classList.contains('active')) returnToHome();
});
$('leave-cancel').addEventListener('click', () => closeModal('leave-modal', $('brand-badge')));
$('leave-confirm').addEventListener('click', returnToHome);

/* Kiosk idle handling: nobody walks away and leaves their name on screen for the next person. */
let lastActivity = Date.now(), idleCountdown = 0;
['pointerdown', 'keydown', 'input', 'wheel'].forEach(type => document.addEventListener(type, () => { lastActivity = Date.now(); }, { passive: true, capture: true }));
setInterval(() => {
  const idle = (Date.now() - lastActivity) / 1000, idleOpen = $('idle-modal').classList.contains('open');
  if (idleOpen) {
    idleCountdown--; $('idle-count').textContent = String(Math.max(0, idleCountdown));
    if (idleCountdown <= 0) returnToHome();
    return;
  }
  if (screens.game.classList.contains('active') && !state.revealing && idle > CONFIG.idleGameSeconds) {
    idleCountdown = CONFIG.idleCountdownSeconds; $('idle-count').textContent = String(idleCountdown); openModal('idle-modal', 'idle-continue'); return;
  }
  const resettable = screens.result.classList.contains('active') || screens.summary.classList.contains('active') || screens.board.classList.contains('active') || $('registration-modal').classList.contains('open') || $('leave-modal').classList.contains('open');
  if (resettable && idle > CONFIG.idleResetSeconds) returnToHome();
  else if (screens.start.classList.contains('active') && idle > 30 && !$('resume-panel').hidden) offerResume();
}, 1000);
$('idle-continue').addEventListener('click', () => { lastActivity = Date.now(); closeModal('idle-modal', mapCanvas); });

window.addEventListener('resize', () => { if (screens.game.classList.contains('active') && state.current) { applyMapView(); refreshMarkers(); } });
updateTop();

/* CMS breakout protection retained from RFDS source */
(function unleashSandbox() {
  try {
    const sandbox = document.getElementById('rfds-sandbox'); if (!sandbox) return;
    let parent = sandbox.parentElement;
    while (parent && parent.tagName !== 'BODY' && parent.tagName !== 'HTML') {
      const style = window.getComputedStyle(parent);
      if (style.overflow === 'hidden' || style.overflow === 'clip') parent.style.setProperty('overflow', 'visible', 'important');
      if (style.overflowX === 'hidden' || style.overflowX === 'clip') parent.style.setProperty('overflow-x', 'visible', 'important');
      if (style.maxWidth && style.maxWidth !== 'none' && style.maxWidth !== '100%') parent.style.setProperty('max-width', 'none', 'important');
      parent = parent.parentElement;
    }
  } catch (e) { console.warn('rfds-sandbox breakout restricted:', e); }
})();
