const crypto = require('node:crypto');
const destinations = require('../data/destinations');
const rules = require('../data/rules');
const remotes = destinations.filter(d => d.role === 'remote');

// Integrity thresholds. Flagged games are saved but held off the public board until staff approve them.
const MIN_MS_PER_FLIGHT = 3000;        // The reveal alone takes ~6 s, so faster submissions are not a person playing.
const NEAR_PERFECT_TOTAL_KM = 6;       // Three pins averaging under 2 km.
const OFFLINE_REVIEW_SCORE = 3800;     // Offline games have no server timing, so very high ones get a human check.

function config() {
  const timezone = process.env.PIN_TO_WIN_TIMEZONE || 'Australia/Adelaide';
  new Intl.DateTimeFormat('en-AU', { timeZone: timezone }).format();
  return { timezone, eventId: process.env.PIN_TO_WIN_EVENT_ID || 'rfds-conference' };
}
function eventDay(date = new Date(), timezone = config().timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
const distance = rules.haversineKm;
const scoring = rules.scoreFor;
function validatePlan(ids) {
  return Array.isArray(ids) && ids.length === 3 && new Set(ids).size === 3 && ids.every(id => remotes.some(d => d.id === id));
}
function pickPlan() { return rules.pickPlanIds(remotes, n => crypto.randomInt(n)); }
function computeFlights(ids, guesses) {
  if (!validatePlan(ids) || !Array.isArray(guesses) || guesses.length > 3) throw new Error('Invalid game.');
  return guesses.map((g, i) => {
    if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon) || g.lat < -46 || g.lat > -8 || g.lon < 110 || g.lon > 156) throw new Error('Invalid map coordinate.');
    const d = remotes.find(d => d.id === ids[i]), hint = g.hint === true;
    const distanceKm = distance(g, d), points = scoring(distanceKm, hint);
    return { destinationId: d.id, lat: g.lat, lon: g.lon, hint, distanceKm, base: points.base, bonus: points.bonus, penalty: points.penalty, score: points.total };
  });
}
function sameGuess(a, b) { return a.lat === b.lat && a.lon === b.lon && (a.hint === true) === (b.hint === true); }
function totals(flights) {
  return { score: flights.reduce((sum, f) => sum + f.score, 0), total_distance: flights.reduce((sum, f) => sum + f.distanceKm, 0) };
}
// Returns a short reason when a completed game should wait for staff review, otherwise ''.
function reviewReason({ flights, source, fast }) {
  if (flights.length !== 3) return fast ? 'fast' : '';
  const { score, total_distance } = totals(flights);
  if (fast) return 'fast';
  if (total_distance < NEAR_PERFECT_TOTAL_KM) return 'near-perfect';
  if (source === 'offline' && score >= OFFLINE_REVIEW_SCORE) return 'offline-high-score';
  return '';
}
function secret() {
  const value = process.env.PIN_TO_WIN_ADMIN_SESSION_SECRET || process.env.SUPABASE_SECRET_KEY;
  if (!value) throw new Error('Session signing is not configured.');
  return value;
}
function token(game) {
  const payload = Buffer.from(JSON.stringify({ id: game.id, event: game.event_id })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}
function verifyToken(value, id, event) {
  try {
    const [data, sig] = String(value || '').split('.');
    const expected = crypto.createHmac('sha256', secret()).update(data).digest('base64url');
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    return payload.id === id && payload.event === event;
  } catch { return false; }
}
const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
// Email players keep one identity across devices. Guests are grouped by name on the same device,
// so one person replaying on a kiosk can't fill the board; different devices stay separate.
function playerId(email, name, deviceId) {
  const hmac = value => crypto.createHmac('sha256', secret()).update(value).digest('hex');
  if (email) return 'email:' + hmac(email.toLowerCase());
  if (isUuid(deviceId) && name) return 'guest:' + hmac('guest|' + rules.nameKey(name) + '|' + deviceId.toLowerCase());
  return 'guest:' + crypto.randomUUID();
}

// Per-instance, in-memory rate limiting. A speed bump against scripted floods, not a guarantee:
// serverless instances do not share memory. Conference iPads share one IP, so limits are generous.
const buckets = new Map();
function rateLimited(key, limit, windowMs = 60000, now = Date.now()) {
  if (process.env.PIN_TO_WIN_RATE_LIMIT === 'off') return false;
  const entry = buckets.get(key);
  if (!entry || now - entry.start > windowMs) { buckets.set(key, { start: now, count: 1 }); if (buckets.size > 5000) buckets.clear(); return false; }
  entry.count++;
  return entry.count > limit;
}
function clientIp(req) {
  return String(req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

class DatabaseError extends Error { constructor(status, code) { super('Cloud leaderboard is unavailable.'); this.status = status; this.code = code; } }
async function db(route, { method = 'GET', body, prefer } = {}) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new DatabaseError(503, 'CONFIG_MISSING');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', apikey: key };
  // New sb_secret keys belong in apikey; only legacy JWT service keys are Bearer tokens.
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(url + '/rest/v1/' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(7000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new DatabaseError(response.status, data?.code || 'DATABASE_ERROR');
  return data;
}
function clean(value, max = 120) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max); }
function json(res, status, body, cache = 'no-store') {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(body));
}
module.exports = {
  config, eventDay, distance, scoring, validatePlan, pickPlan, computeFlights, sameGuess, totals, reviewReason, playerId, token, verifyToken,
  isUuid, rateLimited, clientIp, db, clean, json, DatabaseError, remotes, MIN_MS_PER_FLIGHT, NEAR_PERFECT_TOTAL_KM, OFFLINE_REVIEW_SCORE
};
