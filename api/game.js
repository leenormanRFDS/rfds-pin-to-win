const rules = require('../data/rules');
const { config, eventDay, pickPlan, computeFlights, sameGuess, totals, reviewReason, playerId, token, verifyToken, isUuid, rateLimited, clientIp, db, clean, json, remotes, MIN_MS_PER_FLIGHT } = require('../lib/game');

const LIMITS = { board: 240, crowd: 120, start: 40, progress: 150, recover: 60 };
const emailOk = email => !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Rank of this game among each player's best score, all-time and for its conference day.
// Needs supabase/pin_to_win_v1_3.sql; returns null (and the UI says "rank pending") if it is not applied yet.
async function rankOf(conf, id, day) {
  try {
    const call = body => db('rpc/pin_to_win_rank', { method: 'POST', body: { event_key: conf.eventId, game_key: id, ...body } });
    const [all, daily] = await Promise.all([call({}), call({ day_key: day })]);
    const shape = row => row ? { rank: Number(row.rank), total: Number(row.total), bestScore: row.best_score == null ? null : Number(row.best_score) } : null;
    return { allTime: shape(all?.[0]), today: shape(daily?.[0]) };
  } catch (error) {
    console.error('Rank lookup failed:', error.code || error.name);
    return null;
  }
}

function playerFields(body) {
  const name = rules.normaliseName(clean(body.name, 80));
  const email = clean(body.email).toLowerCase();
  const organisation = rules.normaliseName(clean(body.organisation, 40));
  const problem = rules.nameProblem(name) || (!emailOk(email) ? 'Enter a valid email, or leave it blank.' : '') || (organisation && rules.nameProblem(organisation) ? 'Please choose a different organisation name.' : '');
  return { name, email, organisation, deviceId: isUuid(body.deviceId) ? body.deviceId : '', problem };
}

module.exports = async function handler(req, res) {
  try {
    const conf = config(), today = eventDay();
    const action = clean(req.query?.action || (req.method === 'GET' ? 'board' : ''), 20);
    if (LIMITS[action] && rateLimited(clientIp(req) + ':' + action, LIMITS[action])) return json(res, 429, { ok: false, error: 'Too many requests. Please wait a moment.' });

    if (req.method === 'GET' && action === 'config') return json(res, 200, { ok: true, ...conf, today });

    if (req.method === 'GET' && action === 'board') {
      const scope = clean(req.query?.scope, 10);
      let day = clean(req.query?.day, 10);
      if (scope === 'today') day = today;
      if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 400, { ok: false, error: 'Invalid conference date.' });
      if (scope === 'teams') {
        const rows = await db('rpc/pin_to_win_team_board', { method: 'POST', body: { event_key: conf.eventId, day_key: day || null } });
        return json(res, 200, { ok: true, ...conf, today, ...(day ? { day } : {}), scope: 'teams', rows: rows || [] });
      }
      // The main board is perpetual. A date (or scope=today) reads that day's archive.
      if (!day) {
        const rows = await db('rpc/pin_to_win_all_time_board', { method: 'POST', body: { event_key: conf.eventId } });
        return json(res, 200, { ok: true, ...conf, today, scope: 'all-time', rows: rows || [] });
      }
      const rows = await db('rpc/pin_to_win_daily_board', { method: 'POST', body: { event_key: conf.eventId, day_key: day } });
      return json(res, 200, { ok: true, ...conf, today, day, scope: 'daily', rows: rows || [] });
    }

    // Where other players pinned one destination. Anonymous coordinates only, rounded to ~1 km.
    if (req.method === 'GET' && action === 'crowd') {
      const destination = clean(req.query?.destination, 60);
      if (!remotes.some(d => d.id === destination)) return json(res, 400, { ok: false, error: 'Unknown destination.' });
      const rows = await db(`pin_to_win_games?event_id=eq.${encodeURIComponent(conf.eventId)}&mission_ids=cs.${encodeURIComponent('{' + destination + '}')}&hidden_at=is.null&select=mission_ids,guesses&order=updated_at.desc&limit=400`);
      const points = [];
      for (const row of rows || []) {
        const index = (row.mission_ids || []).indexOf(destination), guess = row.guesses?.[index];
        if (guess && Number.isFinite(guess.lat) && Number.isFinite(guess.lon)) points.push({ lat: Math.round(guess.lat * 100) / 100, lon: Math.round(guess.lon * 100) / 100 });
      }
      return json(res, 200, { ok: true, destinationId: destination, points }, 'public, s-maxage=30, stale-while-revalidate=60');
    }

    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { ok: false, error: 'Method not allowed.' }); }
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || JSON.stringify(body).length > 18000 || !isUuid(body.id) || (body.eventId && body.eventId !== conf.eventId)) return json(res, 400, { ok: false, error: 'Invalid game submission.' });

    if (action === 'start') {
      const player = playerFields(body);
      if (player.problem) return json(res, 400, { ok: false, error: player.problem, field: 'name' });
      // A start is idempotent but never returns an existing game's credentials.
      const existing = await db(`pin_to_win_games?id=eq.${body.id}&select=id`);
      if (existing?.length) return json(res, 409, { ok: false, error: 'Game already exists. Retry using its saved session.' });
      const now = new Date().toISOString();
      const game = {
        id: body.id, event_id: conf.eventId, event_day: today, timezone: conf.timezone, player_id: playerId(player.email, player.name, player.deviceId),
        full_name: player.name, email: player.email || null, mission_ids: pickPlan(), started_at: now, updated_at: now, source: 'online',
        ...(player.organisation ? { organisation: player.organisation } : {})
      };
      await db('pin_to_win_games', { method: 'POST', body: game, prefer: 'return=minimal' });
      return json(res, 200, { ok: true, token: token(game), plan: game.mission_ids, day: today, ...conf });
    }

    if (action === 'progress') {
      if (!verifyToken(body.token, body.id, conf.eventId)) return json(res, 401, { ok: false, error: 'Invalid game session.' });
      const [game] = await db(`pin_to_win_games?id=eq.${body.id}&event_id=eq.${encodeURIComponent(conf.eventId)}&select=*`);
      if (!game) return json(res, 404, { ok: false, error: 'Game session not found.' });
      const flights = computeFlights(game.mission_ids, body.guesses);
      const previous = game.guesses || [];
      // Queued snapshots may be retried out of order. Never erase or alter a locked guess.
      for (let i = 0; i < Math.min(previous.length, flights.length); i++) if (!sameGuess(previous[i], flights[i])) return json(res, 409, { ok: false, error: 'A locked pin cannot be changed.' });
      if (flights.length <= previous.length) {
        const review = !!(game.review_reason && game.hidden_at);
        return json(res, 200, { ok: true, day: game.event_day, completed: game.completed, score: game.score, review, ...(game.completed ? { rank: await rankOf(conf, game.id, game.event_day) } : {}) });
      }
      const nowMs = Date.now(), now = new Date(nowMs).toISOString();
      const lastStep = Date.parse(previous.length ? game.updated_at : game.started_at), added = flights.length - previous.length;
      const fast = Number.isFinite(lastStep) && nowMs - lastStep < MIN_MS_PER_FLIGHT * added;
      const completed = flights.length === 3;
      const reason = game.review_reason || reviewReason({ flights, source: 'online', fast }) || '';
      const { score, total_distance } = totals(flights);
      const patch = {
        guesses: flights, score, total_distance, completed, revision: game.revision + 1, updated_at: now,
        // Optional columns are only written when needed, so normal games still save before the v1.3 migration.
        ...(reason && !game.review_reason ? { review_reason: reason } : {}),
        ...(completed && reason && !game.hidden_at ? { hidden_at: now } : {})
      };
      const updated = await db(`pin_to_win_games?id=eq.${body.id}&revision=eq.${game.revision}`, { method: 'PATCH', prefer: 'return=representation', body: patch });
      if (!updated?.length) return json(res, 409, { ok: false, error: 'Game updated elsewhere. Retry your saved progress.' });
      return json(res, 200, { ok: true, day: game.event_day, completed, score, review: completed && !!reason, ...(completed ? { rank: await rankOf(conf, game.id, game.event_day) } : {}) });
    }

    if (action === 'recover') {
      const player = playerFields(body), started = new Date(body.startedAt);
      if (player.problem || !Number.isFinite(started.getTime()) || started.getTime() > Date.now() + 300000 || started.getTime() < Date.now() - 14 * 86400000) return json(res, 400, { ok: false, error: player.problem || 'Invalid offline session.' });
      const flights = computeFlights(body.plan, body.guesses);
      const existing = await db(`pin_to_win_games?id=eq.${body.id}&select=*`);
      if (existing?.length) {
        const old = existing[0];
        const exact = old.source === 'offline' && old.full_name === player.name && (old.email || '') === player.email && JSON.stringify(old.mission_ids) === JSON.stringify(body.plan) && old.guesses.length === flights.length && old.guesses.every((g, i) => sameGuess(g, flights[i]));
        if (exact) return json(res, 200, { ok: true, day: old.event_day, score: old.score, completed: true, review: !!(old.review_reason && old.hidden_at), rank: await rankOf(conf, old.id, old.event_day) });
        return json(res, 409, { ok: false, error: 'This game ID is already in use. Staff can review the saved local backup.' });
      }
      if (flights.length !== 3) return json(res, 400, { ok: false, error: 'Complete three flights before recovering an offline game.' });
      const day = eventDay(started, conf.timezone), { score, total_distance } = totals(flights), now = new Date().toISOString();
      const reason = reviewReason({ flights, source: 'offline' });
      const game = {
        id: body.id, event_id: conf.eventId, event_day: day, timezone: conf.timezone, player_id: playerId(player.email, player.name, player.deviceId),
        full_name: player.name, email: player.email || null, mission_ids: body.plan, started_at: started.toISOString(), updated_at: now, source: 'offline',
        guesses: flights, score, total_distance, completed: true, revision: 3,
        ...(player.organisation ? { organisation: player.organisation } : {}),
        ...(reason ? { review_reason: reason, hidden_at: now } : {})
      };
      // On retry, the same UUID can only insert once. An exact replay returns its prior result.
      await db('pin_to_win_games', { method: 'POST', body: game, prefer: 'return=minimal,resolution=ignore-duplicates' });
      return json(res, 200, { ok: true, day, score, completed: true, review: !!reason, rank: await rankOf(conf, game.id, day) });
    }
    return json(res, 400, { ok: false, error: 'Unknown game action.' });
  } catch (error) {
    if (error.message?.startsWith('Invalid ')) return json(res, 400, { ok: false, error: error.message });
    if (error instanceof SyntaxError) return json(res, 400, { ok: false, error: 'Invalid game submission.' });
    const setupRequired = ['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205', 'CONFIG_MISSING'].includes(error.code);
    console.error('Leaderboard request failed:', error.code || error.name);
    return json(res, 503, { ok: false, setupRequired, error: setupRequired ? 'Cloud leaderboard setup is pending. Local game progress is retained.' : 'Cloud leaderboard is temporarily unavailable. Your device backup will retry.' });
  }
};
