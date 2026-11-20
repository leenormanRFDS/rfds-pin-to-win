const rules = require('../data/rules');
const { rateLimited, clientIp } = require('../lib/game');

// Only players who tick the contact box are recorded here. Leaderboard play alone is not an expression of interest.
const CONSENT_VERSION = '2026-11-v1';

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function clean(value, max = 1000) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'Method not allowed.' });
  }
  if (rateLimited(clientIp(req) + ':eoi', 30)) return json(res, 429, { ok: false, error: 'Too many requests. Please wait a moment.' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (!body || typeof body !== 'object') {
      return json(res, 400, { ok: false, error: 'Invalid request.' });
    }

    // Honeypot: a hidden field people never see. Pretend success for bots.
    const website = clean(body.website, 200);
    if (website) return json(res, 200, { ok: true });

    const clientId = clean(body.clientId, 120);
    const fullName = rules.normaliseName(clean(body.fullName || body.name, 120));
    const email = clean(body.email, 320).toLowerCase();
    const organisation = rules.normaliseName(clean(body.organisation, 40));

    if (body.contactOptIn !== true) return json(res, 400, { ok: false, error: 'Contact consent is required.' });
    if (!clientId || !fullName || !validEmail(email)) {
      return json(res, 400, { ok: false, error: 'Please provide your name and a valid email.' });
    }

    const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || '';

    if (!supabaseUrl || !supabaseSecretKey) {
      console.error('PIN TO WIN EOI backend is missing SUPABASE_URL or SUPABASE_SECRET_KEY');
      return json(res, 500, { ok: false, error: 'Submission service is not configured.' });
    }

    const record = {
      client_id: clientId,
      full_name: fullName,
      email,
      organisation: organisation || null,
      contact_opt_in: true,
      consent_version: CONSENT_VERSION,
      source_url: clean(body.sourceUrl, 1000) || null,
      user_agent: clean(req.headers['user-agent'], 1000) || null
    };

    const response = await fetch(`${supabaseUrl}/rest/v1/pin_to_win_eois`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'apikey': supabaseSecretKey,
        ...(supabaseSecretKey.startsWith('eyJ') ? { Authorization: `Bearer ${supabaseSecretKey}` } : {}),
        'Prefer': 'return=minimal,resolution=ignore-duplicates'
      },
      body: JSON.stringify(record)
    });

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      console.error('PIN TO WIN Supabase insert failed:', response.status, details);
      return json(res, 502, { ok: false, error: 'We could not save your details.' });
    }

    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('PIN TO WIN EOI backend error:', error);
    return json(res, 500, { ok: false, error: 'We could not save your details.' });
  }
};

module.exports.CONSENT_VERSION = CONSENT_VERSION;
