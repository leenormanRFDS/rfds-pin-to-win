// In-memory stand-in for the Supabase REST API, covering the queries Pin to Win makes.
// Used by the tests and by `npm run dev`. Not a general PostgREST implementation.
function createMock() {
  const tables = { pin_to_win_games: new Map(), pin_to_win_eois: new Map() };
  const requests = [];
  const visibleBest = (eventKey, dayKey, extra = () => true) => {
    const best = new Map();
    const rows = [...tables.pin_to_win_games.values()]
      .filter(r => r.event_id === eventKey && r.completed && !r.hidden_at && (!dayKey || r.event_day === dayKey) && extra(r))
      .sort((a, b) => b.score - a.score || a.total_distance - b.total_distance || String(a.started_at).localeCompare(String(b.started_at)) || String(a.id).localeCompare(String(b.id)));
    for (const row of rows) if (!best.has(row.player_id)) best.set(row.player_id, row);
    return [...best.values()];
  };
  const rpc = {
    pin_to_win_all_time_board: b => visibleBest(b.event_key).slice(0, 20).map(r => ({ id: r.id, name: r.full_name, score: r.score, total_distance: r.total_distance, source: r.source })),
    pin_to_win_daily_board: b => visibleBest(b.event_key, b.day_key).slice(0, 20).map(r => ({ id: r.id, name: r.full_name, score: r.score, total_distance: r.total_distance, source: r.source })),
    pin_to_win_rank: b => {
      const me = tables.pin_to_win_games.get(b.game_key); if (!me || me.event_id !== b.event_key || !me.completed) return [];
      const best = visibleBest(b.event_key, b.day_key), others = best.filter(r => r.player_id !== me.player_id);
      return [{ rank: 1 + others.filter(r => r.score > me.score || (r.score === me.score && r.total_distance < me.total_distance)).length, total: 1 + others.length, best_score: best.find(r => r.player_id === me.player_id)?.score ?? null }];
    },
    pin_to_win_team_board: b => {
      const groups = new Map();
      for (const r of visibleBest(b.event_key, b.day_key, r => (r.organisation || '').trim())) {
        const key = r.organisation.trim().toLowerCase(); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r);
      }
      return [...groups.values()].filter(g => g.length >= 2).map(g => ({ team: g[0].organisation.trim(), players: g.length, average_score: Math.round(g.reduce((s, r) => s + r.score, 0) / g.length), top_score: Math.max(...g.map(r => r.score)) }))
        .sort((a, b) => b.average_score - a.average_score || b.players - a.players).slice(0, 20);
    }
  };
  function matches(row, params) {
    for (const [key, raw] of params) {
      if (['select', 'order', 'offset', 'limit'].includes(key)) continue;
      const value = row[key];
      if (raw === 'is.null') { if (value != null) return false; continue; }
      if (raw === 'not.is.null') { if (value == null) return false; continue; }
      if (raw.startsWith('eq.')) { if (String(value) !== raw.slice(3)) return false; continue; }
      if (raw.startsWith('lte.')) { if (!(String(value) <= raw.slice(4))) return false; continue; }
      if (raw.startsWith('cs.{')) { const needle = raw.slice(4, -1); if (!Array.isArray(value) || !value.includes(needle)) return false; continue; }
    }
    return true;
  }
  const reply = (body, status = 200) => Promise.resolve(body === null ? new Response(null, { status }) : Response.json(body, { status }));
  async function fetch(url, opts = {}) {
    requests.push({ url, opts });
    const parsed = new URL(url), path = parsed.pathname.replace(/^\/rest\/v1\//, ''), body = opts.body ? JSON.parse(opts.body) : null;
    if (path.startsWith('rpc/')) { const fn = rpc[path.slice(4)]; return fn ? reply(fn(body || {})) : reply({ code: 'PGRST202' }, 404); }
    const table = tables[path]; if (!table) return reply({ code: 'PGRST205' }, 404);
    const params = [...parsed.searchParams.entries()], method = opts.method || 'GET';
    if (method === 'POST') {
      const key = body.id || body.client_id;
      if ([...table.values()].some(r => (body.id && r.id === body.id) || (body.client_id && r.client_id === body.client_id))) return opts.headers?.Prefer?.includes('ignore-duplicates') ? reply(null, 201) : reply({ code: '23505' }, 409);
      const defaults = path === 'pin_to_win_games' ? { guesses: [], revision: 0, score: 0, total_distance: 0, completed: false, hidden_at: null, review_reason: null } : { id: key, submitted_at: new Date().toISOString() };
      table.set(key, { ...defaults, ...body }); return reply(null, 201);
    }
    let rows = [...table.values()].filter(r => matches(r, params));
    if (method === 'PATCH') { const out = rows.map(r => { Object.assign(r, body); return r; }); return reply(opts.headers?.Prefer?.includes('representation') ? out : null, opts.headers?.Prefer?.includes('representation') ? 200 : 204); }
    const order = parsed.searchParams.get('order');
    if (order) { const [col, dir] = order.split(',')[0].split('.'); rows.sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (dir === 'desc' ? -1 : 1)); }
    const offset = Number(parsed.searchParams.get('offset') || 0), limit = Number(parsed.searchParams.get('limit') || 1e9);
    return reply(rows.slice(offset, offset + limit));
  }
  return { tables, requests, fetch, games: tables.pin_to_win_games, eois: tables.pin_to_win_eois };
}
module.exports = { createMock };
