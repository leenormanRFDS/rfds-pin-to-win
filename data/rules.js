// Shared game rules. Loaded by the browser (window.PTW_RULES) and by Node (require).
// Keep scoring, draws and name checks here so the client preview and the server never drift apart.
(function (root) {
  const HINT_PENALTY = 150;
  const MAX_FLIGHT_SCORE = 1400;
  const HINT_RADIUS_KM = 300;

  function haversineKm(a, b) {
    const R = 6371, rad = v => v * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
  }

  // Smooth curve: no cliff edges. Base falls 1 point per km; the precision bonus decays
  // exponentially (400 at 0 km, ~327 at 10 km, ~243 at 25 km, ~147 at 50 km, ~54 at 100 km).
  function scoreFor(km, hint = false) {
    const base = Math.max(0, Math.round(1000 - km));
    const bonus = Math.round(400 * Math.exp(-km / 50));
    const penalty = hint ? HINT_PENALTY : 0;
    return { base, bonus, penalty, total: Math.max(0, base + bonus - penalty) };
  }

  function shuffle(list, randomInt) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // Every game gets the same difficulty shape (easier → harder) across three different RFDS sections,
  // so a perpetual board is decided by navigation rather than by a lucky draw.
  const TIERS = [[2, 3], [3, 4], [4, 5]];
  function pickPlanIds(remotes, randomInt) {
    const pool = shuffle(remotes, randomInt);
    const sections = shuffle([...new Set(remotes.map(d => d.section))], randomInt);
    const chosen = [], used = new Set();
    for (const tier of TIERS) {
      let pick = null;
      for (const section of sections) {
        if (used.has(section)) continue;
        pick = pool.find(d => d.section === section && tier.includes(d.difficulty) && !chosen.includes(d));
        if (pick) break;
      }
      pick = pick || pool.find(d => tier.includes(d.difficulty) && !chosen.includes(d)) || pool.find(d => !chosen.includes(d));
      chosen.push(pick); used.add(pick.section);
    }
    return chosen.map(d => d.id);
  }

  // Ranks are awarded on the final three-flight score (maximum 4,200).
  const RANKS = [
    [4000, 'Chief Pilot'],
    [3750, 'Senior Captain'],
    [3300, 'Captain'],
    [2700, 'First Officer'],
    [1800, 'Navigator'],
    [0, 'Cadet']
  ];
  function rankFor(score) {
    const index = RANKS.findIndex(([min]) => score >= min);
    const [, title] = RANKS[index];
    const next = index > 0 ? RANKS[index - 1] : null;
    return { title, next: next ? { title: next[1], needed: next[0] - score } : null };
  }

  // flights: [{ distanceKm, hint }]
  function badgesFor(flights) {
    const km = flights.map(f => f.distanceKm), badges = [];
    if (km.some(k => k <= 5)) badges.push({ id: 'bullseye', title: 'Bullseye', detail: 'A pin within 5 km' });
    else if (km.some(k => k <= 25)) badges.push({ id: 'pinpoint', title: 'Pinpoint', detail: 'A pin within 25 km' });
    if (km.length === 3 && km.every(k => k <= 100)) badges.push({ id: 'clean-sweep', title: 'Clean sweep', detail: 'All three flights within 100 km' });
    if (km.length === 3 && flights.every(f => !f.hint) && km.every(k => k <= 250)) badges.push({ id: 'unassisted', title: 'Unassisted', detail: 'No hints, every pin within 250 km' });
    if (km.length === 3 && km[2] <= 50) badges.push({ id: 'outback-ace', title: 'Outback ace', detail: 'The hardest flight within 50 km' });
    return badges;
  }

  // Consecutive flights within 100 km, counted back from the most recent flight.
  function streakFor(flights) {
    let n = 0;
    for (let i = flights.length - 1; i >= 0 && flights[i].distanceKm <= 100; i--) n++;
    return n;
  }

  // Public leaderboard names. A starting list: extend it for your audience.
  const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i' };
  const BLOCKED_PARTS = ['fuck', 'nigger', 'nigga', 'faggot', 'motherf'];
  const BLOCKED_WORDS = new Set(['shit', 'shite', 'cunt', 'bitch', 'bastard', 'wanker', 'wank', 'dickhead', 'cock', 'prick', 'twat', 'slut', 'whore',
    'piss', 'arse', 'ass', 'asshole', 'arsehole', 'bollocks', 'retard', 'rape', 'rapist', 'nazi', 'hitler', 'porn', 'tits', 'boobs', 'penis', 'vagina',
    'coon', 'spic', 'chink', 'gook', 'kike', 'poof', 'poofter', 'dyke', 'tranny', 'abo', 'boong', 'fag', 'nonce', 'pedo', 'paedo']);
  function normaliseName(name) { return String(name || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim(); }
  function nameKey(name) { return normaliseName(name).toLowerCase(); }
  function nameProblem(name) {
    const clean = normaliseName(name);
    if (clean.length < 2) return 'Enter a leaderboard name of at least two characters.';
    if (clean.length > 40) return 'Keep your leaderboard name to 40 characters or fewer.';
    if (/https?:|www\.|\.com\b|@/i.test(clean)) return 'Please don’t use a web address or email as your leaderboard name.';
    const folded = clean.toLowerCase().replace(/./g, c => LEET[c] || c);
    const tokens = folded.split(/[^a-z]+/).filter(Boolean), squashed = tokens.join('');
    if (BLOCKED_PARTS.some(p => squashed.includes(p)) || tokens.some(t => BLOCKED_WORDS.has(t)) || BLOCKED_WORDS.has(squashed)) return 'Please choose a different leaderboard name.';
    return '';
  }

  const api = { HINT_PENALTY, MAX_FLIGHT_SCORE, HINT_RADIUS_KM, haversineKm, scoreFor, pickPlanIds, rankFor, badgesFor, streakFor, normaliseName, nameKey, nameProblem, shuffle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PTW_RULES = api;
})(typeof window !== 'undefined' ? window : globalThis);
