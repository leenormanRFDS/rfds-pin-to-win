const { test, beforeEach } = require('node:test'); const assert = require('node:assert/strict');
process.env.SUPABASE_URL = 'https://example.invalid'; process.env.SUPABASE_SECRET_KEY = 'test-only-not-a-credential'; process.env.PIN_TO_WIN_RATE_LIMIT = 'off';
const handler = require('../api/eoi'); const { createMock } = require('./helpers/mock-supabase');
let mock;
async function call(body) { let status = 200, data; const res = { status(c) { status = c; return this }, setHeader() { return this }, end(v) { data = JSON.parse(v) } }; await handler({ method: 'POST', body, headers: { 'user-agent': 'test' } }, res); return { status, data }; }
beforeEach(() => { mock = createMock(); global.fetch = mock.fetch; });

test('contact entries require explicit consent and an email', async () => {
  assert.equal((await call({ clientId: 'a', fullName: 'Sam', email: 'sam@example.com' })).status, 400);
  assert.equal((await call({ clientId: 'a', fullName: 'Sam', email: '', contactOptIn: true })).status, 400);
  assert.equal(mock.eois.size, 0);
  const r = await call({ clientId: 'a', fullName: 'Sam', email: 'SAM@example.com', organisation: 'Port Augusta Crew', contactOptIn: true });
  assert.equal(r.status, 200);
  const row = [...mock.eois.values()][0];
  assert.equal(row.email, 'sam@example.com'); assert.equal(row.contact_opt_in, true); assert.equal(row.consent_version, handler.CONSENT_VERSION); assert.equal(row.organisation, 'Port Augusta Crew');
});

test('the hidden honeypot field silently drops bot submissions', async () => {
  const r = await call({ clientId: 'b', fullName: 'Bot', email: 'bot@example.com', contactOptIn: true, website: 'http://spam.example' });
  assert.equal(r.status, 200); assert.equal(mock.eois.size, 0);
});
