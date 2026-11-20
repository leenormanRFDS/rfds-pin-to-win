const { test } = require('node:test'); const assert = require('node:assert/strict');
const rules = require('../data/rules'), destinations = require('../data/destinations');

test('scoring is smooth, capped at 1,400 per flight and never negative', () => {
  assert.deepEqual(rules.scoreFor(0), { base: 1000, bonus: 400, penalty: 0, total: 1400 });
  let previous = Infinity;
  for (let km = 0; km <= 1200; km += 0.5) { const { total } = rules.scoreFor(km); assert(total <= previous, `not decreasing at ${km}`); assert(total >= 0); previous = total; }
  // The old bands dropped 100+ points across a single kilometre. No cliffs now.
  for (const edge of [5, 10, 25, 50, 100]) assert(rules.scoreFor(edge - 0.1).total - rules.scoreFor(edge + 0.1).total <= 3, `cliff at ${edge} km`);
  assert.equal(rules.scoreFor(1200, true).total, 0);
  assert.equal(rules.scoreFor(20).total - rules.scoreFor(20, true).total, rules.HINT_PENALTY);
});

test('ranks, badges and streaks', () => {
  assert.equal(rules.rankFor(4200).title, 'Chief Pilot'); assert.equal(rules.rankFor(4200).next, null);
  assert.deepEqual(rules.rankFor(3700), { title: 'Captain', next: { title: 'Senior Captain', needed: 50 } });
  assert.equal(rules.rankFor(0).title, 'Cadet');
  const ids = flights => rules.badgesFor(flights).map(b => b.id);
  assert.deepEqual(ids([{ distanceKm: 4 }, { distanceKm: 60 }, { distanceKm: 40 }]), ['bullseye', 'clean-sweep', 'unassisted', 'outback-ace']);
  assert.deepEqual(ids([{ distanceKm: 20, hint: true }, { distanceKm: 300 }, { distanceKm: 400 }]), ['pinpoint']);
  assert.equal(rules.streakFor([{ distanceKm: 300 }, { distanceKm: 50 }, { distanceKm: 90 }]), 2);
  assert.equal(rules.streakFor([{ distanceKm: 50 }, { distanceKm: 300 }]), 0);
});

test('name filter blocks abuse without blocking real names and places', () => {
  for (const ok of ['Sam R', 'Captain Sam', 'Dick Smith', 'Scunthorpe Flyers', 'Cockburn Crew', 'Penistone', 'Assunta', 'Ngaire O’Brien', 'José', 'Port Augusta Crew'])
    assert.equal(rules.nameProblem(ok), '', ok);
  for (const bad of ['sh1t', 'F u c k', 'big wanker', 'FUCKFACE', 'abo', 'www.example.com', 'me@example.com', 'a', 'x'.repeat(41)])
    assert.notEqual(rules.nameProblem(bad), '', bad);
});

test('plan draw climbs in difficulty and spans three sections', () => {
  const remotes = destinations.filter(d => d.role === 'remote');
  for (let i = 0; i < 500; i++) {
    const plan = rules.pickPlanIds(remotes, n => Math.floor(Math.random() * n)).map(id => remotes.find(d => d.id === id));
    assert.equal(new Set(plan.map(d => d.section)).size, 3);
    assert(plan[0].difficulty <= 3 && plan[2].difficulty >= 4);
  }
});
