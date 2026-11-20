'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const SCOPES = [{ scope: 'all-time', title: 'All-time high scores' }, { scope: 'today', title: 'Today’s high scores' }];
  const ROWS = 10, REFRESH_MS = 15000, ROTATE_EVERY = 2; // rotate every second refresh (30 s)
  const seen = { 'all-time': null, today: null };
  let index = 0, ticks = 0;
  const escapeHtml = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));

  async function load() {
    const { scope, title } = SCOPES[index];
    try {
      const response = await fetch('/api/game?action=board&scope=' + scope, { cache: 'no-store', headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unavailable');
      const rows = (data.rows || []).slice(0, ROWS);
      const previous = seen[scope];
      const fresh = previous ? new Set(rows.map(r => r.id).filter(id => !previous.has(id))) : new Set();
      seen[scope] = new Set(rows.map(r => r.id));
      $('bb-heading').textContent = title;
      $('bb-rows').innerHTML = rows.length ? rows.map((r, i) => `<li class="${fresh.has(r.id) ? 'fresh' : ''}"><span class="bb-rank">${i + 1}</span><span class="bb-name">${escapeHtml(r.name)}${fresh.has(r.id) ? '<em>Just landed</em>' : ''}</span><span class="bb-score">${Number(r.score).toLocaleString()}</span></li>`).join('')
        : `<li class="bb-empty">${scope === 'today' ? 'No scores yet today. Be the first.' : 'No scores yet. Be the first.'}</li>`;
      $('bb-status').textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
    } catch {
      $('bb-status').textContent = 'Reconnecting to the leaderboard…';
    }
  }
  async function cycle() {
    await load();
    if (++ticks % ROTATE_EVERY === 0) index = (index + 1) % SCOPES.length;
  }
  cycle(); setInterval(cycle, REFRESH_MS);
})();
