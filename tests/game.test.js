const { test, beforeEach } = require('node:test'); const assert = require('node:assert/strict');
// Dummy, non-production values. No credentials are needed to run these tests.
process.env.SUPABASE_URL = 'https://example.invalid'; process.env.SUPABASE_SECRET_KEY = 'test-only-not-a-credential'; process.env.PIN_TO_WIN_TIMEZONE = 'Australia/Adelaide'; process.env.PIN_TO_WIN_EVENT_ID = 'test-conference'; process.env.PIN_TO_WIN_RATE_LIMIT = 'off';
const game = require('../lib/game'), rules = require('../data/rules'), handler = require('../api/game'), destinations = require('../data/destinations');
const { createMock } = require('./helpers/mock-supabase'); const { randomUUID } = require('node:crypto');
let mock;
const dest = id => destinations.find(d => d.id === id);
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
// Guesses `km` north of each destination.
const near = (plan, km = 0, hint = false) => plan.map(id => ({ lat: dest(id).lat + km / 111.32, lon: dest(id).lon, ...(hint ? { hint: true } : {}) }));
async function call(action, body, method = body ? 'POST' : 'GET', query = {}) { let status = 200, data, headers = {}; const res = { status(code) { status = code; return this }, setHeader(k, v) { headers[k] = v; return this }, end(v) { data = JSON.parse(v) } }; await handler({ method, query: { action, ...query }, body, headers: {} }, res); return { status, data, headers }; }
// Start a game and pretend it began `minutes` ago, so the per-flight timing floor is satisfied.
async function started(extra = {}, minutes = 10) { const id = randomUUID(), r = await call('start', { id, name: 'Test Pilot', ...extra }); assert.equal(r.status, 200, JSON.stringify(r.data)); const row = mock.games.get(id); row.started_at = row.updated_at = ago(minutes); return { id, token: r.data.token, plan: r.data.plan }; }
async function play(g, guesses) { const r = await call('progress', { id: g.id, token: g.token, guesses }); const row = mock.games.get(g.id); if (row) row.updated_at = ago(5); return r; }
beforeEach(() => { mock = createMock(); global.fetch = mock.fetch; });

test('timezone boundary uses the conference calendar, including Adelaide daylight saving', () => { assert.equal(game.eventDay(new Date('2026-10-26T13:29:59Z')), '2026-10-26'); assert.equal(game.eventDay(new Date('2026-10-26T13:30:00Z')), '2026-10-27'); assert.equal(game.eventDay(new Date('2026-10-26T14:29:59Z'), 'Australia/Darwin'), '2026-10-26'); });
test('optional email starts a server-issued game and keeps secrets off the response', async () => { const r = await call('start', { id: randomUUID(), name: 'Test Pilot', email: '' }); assert.equal(r.status, 200); assert.equal(r.data.plan.length, 3); assert.equal(new Set(r.data.plan).size, 3); assert(r.data.token); assert(!JSON.stringify(r.data).includes(process.env.SUPABASE_SECRET_KEY)); assert.equal([...mock.games.values()][0].email, null); });
test('malformed email, offensive names and web addresses are rejected before a game is created', async () => {
  for (const body of [{ name: 'Pilot', email: 'bad' }, { name: 'sh1t head' }, { name: 'www.spam.com' }, { name: 'x' }, { name: 'Pilot', organisation: 'F u c k' }]) {
    const r = await call('start', { id: randomUUID(), ...body }); assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.data.field, 'name');
  }
  assert.equal(mock.games.size, 0);
});
test('server plans follow the difficulty ladder across three different sections', () => {
  for (let i = 0; i < 300; i++) {
    const plan = game.pickPlan().map(dest);
    assert.equal(new Set(plan.map(d => d.id)).size, 3); assert.equal(new Set(plan.map(d => d.section)).size, 3);
    assert([2, 3].includes(plan[0].difficulty)); assert([3, 4].includes(plan[1].difficulty)); assert([4, 5].includes(plan[2].difficulty));
  }
});
test('scores are recomputed; each flight is saved, locked guesses cannot change, and duplicate completion is idempotent', async () => {
  const g = await started(), guesses = near(g.plan, 11);
  let r = await play(g, guesses.slice(0, 1).map(x => ({ ...x, score: 999999 })));
  assert.equal(r.data.score, rules.scoreFor(rules.haversineKm(guesses[0], dest(g.plan[0]))).total); assert.equal(r.data.completed, false); assert.equal(r.data.rank, undefined);
  const day = mock.games.get(g.id).event_day;
  assert.equal((await call('board', null, 'GET', { day })).data.rows.length, 0);
  r = await play(g, guesses); assert.equal(r.data.completed, true); assert.equal(r.data.review, false);
  assert.deepEqual(r.data.rank, { allTime: { rank: 1, total: 1, bestScore: r.data.score }, today: { rank: 1, total: 1, bestScore: r.data.score } });
  assert.equal((await play(g, guesses)).status, 200); assert.equal(mock.games.size, 1);
  const changed = guesses.map(x => ({ ...x })); changed[0].lat += 1; assert.equal((await play(g, changed)).status, 409);
  const board = await call('board', null, 'GET', { day }); assert.equal(board.data.rows.length, 1); assert(!('email' in board.data.rows[0])); assert(!('player_id' in board.data.rows[0]));
});
test('a hint costs 150 points, is stored with the guess and cannot be removed afterwards', async () => {
  const g = await started(), plain = near(g.plan, 20), hinted = near(g.plan, 20, true);
  const r = await play(g, hinted.slice(0, 1)), expected = rules.scoreFor(rules.haversineKm(plain[0], dest(g.plan[0])));
  assert.equal(r.data.score, expected.total - 150); assert.equal(mock.games.get(g.id).guesses[0].hint, true);
  assert.equal((await play(g, plain.slice(0, 2))).status, 409);
});
test('pins faster than a person can play are saved but held for staff review', async () => {
  const id = randomUUID(), s = await call('start', { id, name: 'Speedy' });
  const r = await call('progress', { id, token: s.data.token, guesses: near(s.data.plan, 40) });
  assert.equal(r.status, 200); assert.equal(r.data.completed, true); assert.equal(r.data.review, true);
  const row = mock.games.get(id); assert.equal(row.review_reason, 'fast'); assert(row.hidden_at);
  assert.equal((await call('board')).data.rows.length, 0);
});
test('a near-perfect game is held for review even when timing is plausible', async () => {
  const g = await started(); await play(g, near(g.plan, 0).slice(0, 2)); const r = await play(g, near(g.plan, 0));
  assert.equal(r.data.score, 4200); assert.equal(r.data.review, true); assert.equal(mock.games.get(g.id).review_reason, 'near-perfect');
});
test('forged token is rejected and games cannot be overwritten through recovery', async () => {
  const g = await started(); assert.equal((await call('progress', { id: g.id, token: 'forged', guesses: [] })).status, 401);
  assert.equal((await call('start', { id: g.id, name: 'Someone else' })).status, 409);
  assert.equal((await call('recover', { id: g.id, name: 'Test Pilot', plan: g.plan, guesses: near(g.plan, 30), startedAt: new Date().toISOString() })).status, 409);
});
test('offline recovery retains the original day, recomputes score and accepts exact retries once', async () => {
  const plan = game.pickPlan(), startedAt = new Date(Date.now() - 86400000).toISOString();
  const payload = { id: randomUUID(), name: 'Offline Pilot', email: '', plan, guesses: near(plan, 35), startedAt, score: 999999 };
  const first = await call('recover', payload); assert.equal(first.status, 200); assert.equal(first.data.day, game.eventDay(new Date(startedAt)));
  assert.equal(first.data.score, game.totals(game.computeFlights(plan, payload.guesses)).score); assert.equal(first.data.review, false);
  assert.equal((await call('recover', payload)).status, 200); assert.equal(mock.games.size, 1); assert.equal((await call('recover', { ...payload, name: 'Different Pilot' })).status, 409);
});
test('very high offline scores wait for review', async () => {
  const plan = game.pickPlan(), r = await call('recover', { id: randomUUID(), name: 'Offline Ace', plan, guesses: near(plan, 11), startedAt: ago(30) });
  assert(r.data.score >= game.OFFLINE_REVIEW_SCORE); assert.equal(r.data.review, true); assert.equal([...mock.games.values()][0].review_reason, 'offline-high-score');
});
test('guests with the same name share one identity per device; other devices and email players stay separate', async () => {
  const deviceA = randomUUID(), deviceB = randomUUID();
  for (const extra of [{ deviceId: deviceA }, { deviceId: deviceA }, { deviceId: deviceB }, {}]) { const g = await started({ name: 'Alex Smith', ...extra }); await play(g, near(g.plan, 30)); }
  assert.equal((await call('board')).data.rows.length, 3);
  const ids = [...mock.games.values()].map(r => r.player_id); assert.equal(ids[0], ids[1]); assert.notEqual(ids[0], ids[2]);
});
test('default board spans dates, keeps each player’s best score, and serves daily and team views', async () => {
  const fixtures = [
    { id: 'old-best', player_id: 'returning', event_day: '2026-10-20', score: 4100, total_distance: 10, organisation: 'Port Augusta' },
    { id: 'new-lower', player_id: 'returning', event_day: '2026-10-26', score: 3000, total_distance: 30, organisation: 'Port Augusta' },
    { id: 'other-guest', player_id: 'guest:other', event_day: '2026-10-26', score: 3500, total_distance: 20, organisation: 'port augusta ' },
    { id: 'solo-team', player_id: 'guest:solo', event_day: '2026-10-26', score: 3600, total_distance: 20, organisation: 'Solo Org' },
    { id: 'partial', player_id: 'partial', event_day: '2026-10-26', score: 1400, total_distance: 0, completed: false },
    { id: 'held', player_id: 'held', event_day: '2026-10-26', score: 4200, total_distance: 0, hidden_at: ago(1), review_reason: 'near-perfect' },
    { id: 'other-event', player_id: 'other', event_day: '2026-10-20', score: 4200, total_distance: 0, event_id: 'different-board' }
  ];
  for (const row of fixtures) mock.games.set(row.id, { event_id: 'test-conference', completed: true, full_name: 'Pilot', source: 'online', hidden_at: null, started_at: row.event_day + 'T00:00:00Z', ...row });
  const board = await call('board'); assert.equal(board.status, 200); assert.equal(board.data.scope, 'all-time'); assert.deepEqual(board.data.rows.map(r => r.id), ['old-best', 'solo-team', 'other-guest']);
  const daily = await call('board', null, 'GET', { day: '2026-10-26' }); assert.equal(daily.data.scope, 'daily'); assert.deepEqual(daily.data.rows.map(r => r.id), ['solo-team', 'other-guest', 'new-lower']);
  const teams = await call('board', null, 'GET', { scope: 'teams' }); assert.deepEqual(teams.data.rows, [{ team: 'Port Augusta', players: 2, average_score: 3800, top_score: 4100 }]);
  assert.equal((await call('board', null, 'GET', { scope: 'today' })).data.scope, 'daily');
  assert.equal((await call('board', null, 'GET', { day: 'invalid' })).status, 400);
});
test('crowd data returns only anonymous, rounded pins for the requested destination and is cacheable', async () => {
  const g = await started({ name: 'Crowd Pilot', email: 'crowd@example.com' }); await play(g, near(g.plan, 30));
  const r = await call('crowd', null, 'GET', { destination: g.plan[1] });
  assert.equal(r.status, 200); assert.equal(r.data.points.length, 1); assert.deepEqual(Object.keys(r.data.points[0]).sort(), ['lat', 'lon']);
  assert(!JSON.stringify(r.data).includes('crowd@example.com')); assert.match(r.headers['Cache-Control'], /s-maxage/);
  assert.equal((await call('crowd', null, 'GET', { destination: 'not-a-place' })).status, 400);
});
test('rate limiting trips per key and resets after the window', () => {
  delete process.env.PIN_TO_WIN_RATE_LIMIT;
  try {
    const key = 'test:' + randomUUID(), t = Date.now();
    for (let i = 0; i < 3; i++) assert.equal(game.rateLimited(key, 3, 60000, t), false);
    assert.equal(game.rateLimited(key, 3, 60000, t), true); assert.equal(game.rateLimited(key, 3, 60000, t + 61000), false);
  } finally { process.env.PIN_TO_WIN_RATE_LIMIT = 'off'; }
});
test('database failure responds explicitly without claiming cloud persistence', async () => { global.fetch = async () => Response.json({ code: 'PGRST205' }, { status: 404 }); const r = await call('board'); assert.equal(r.status, 503); assert.equal(r.data.setupRequired, true); });
test('a missing rank function does not stop a completed game from saving', async () => {
  const g = await started(); const realFetch = mock.fetch;
  global.fetch = (url, opts) => String(url).includes('pin_to_win_rank') ? Promise.resolve(Response.json({ code: 'PGRST202' }, { status: 404 })) : realFetch(url, opts);
  const r = await play(g, near(g.plan, 30)); assert.equal(r.status, 200); assert.equal(r.data.completed, true); assert.equal(r.data.rank, null);
});
