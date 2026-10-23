// StandSafe check-in server: keeps each hunter's timer and texts contacts via Twilio if they miss a check-in.
const express = require('express'), cors = require('cors'), fs = require('fs');
const app = express(); app.use(cors()); app.use(express.json({ limit: '1mb' }));
const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, APP_KEY, PORT = 8080 } = process.env;
const twilio = TWILIO_SID ? require('twilio')(TWILIO_SID, TWILIO_TOKEN) : null;
// Storage: Neon Postgres when DATABASE_URL is set (survives redeploys), otherwise local files.
const { DATABASE_URL } = process.env;
const pool = DATABASE_URL ? new (require('pg').Pool)({ connectionString: DATABASE_URL, max: 3 }) : null;
const DB = __dirname + '/trips.json';
let trips = {};
async function kvGet(k, def) { if (pool) { const r = await pool.query('SELECT v FROM kv WHERE k=$1', [k]); return r.rows[0] ? r.rows[0].v : def; }
  const f = __dirname + '/' + k + '.json'; return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : def; }
async function kvSet(k, v) { if (pool) return pool.query('INSERT INTO kv(k,v,updated_at) VALUES($1,$2,now()) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v, updated_at=now()', [k, JSON.stringify(v)]);
  fs.writeFileSync(__dirname + '/' + k + '.json', JSON.stringify(v, null, 1)); }
const save = () => kvSet('trips', trips).catch(e => console.error('save trips failed', e.message));
app.use('/api', (req, res, next) => (!APP_KEY || req.get('x-app-key') === APP_KEY) ? next() : res.status(401).json({ error: 'bad key' }));

const norm = n => { const d = String(n).replace(/\D/g, ''); return d.length >= 10 ? '+1' + d.slice(-10) : null; };
function consentStatus(n) { const e = norm(n); const recs = optins.filter(o => o.phone === e); const last = recs[recs.length - 1]; return { phone: e, optedIn: !!(last && last.smsConsent) }; }
async function sms(to, body, opts = {}) {
  if (!opts.skipConsent) { const ok = [], skipped = [];
    for (const n of to) { const c = consentStatus(n); if (!c.phone) continue; (c.optedIn ? ok : skipped).push(c.phone); }
    if (skipped.length) console.log('[SMS skipped - not opted in]', skipped.join(', '));
    to = ok; }
  const nums = to.map(n => n.replace(/[^\d+]/g, '')).filter(n => n.length >= 10).map(n => n.startsWith('+') ? n : '+1' + n.slice(-10));
  for (const n of nums) {
    if (twilio) await twilio.messages.create({ to: n, from: TWILIO_FROM, body }).catch(e => console.error('SMS fail', n, e.message));
    else console.log('[SMS dry-run]', n, body);
  }
}
const loc = t => t.last ? `${t.last.lat.toFixed(5)}, ${t.last.lng.toFixed(5)} https://maps.google.com/?q=${t.last.lat},${t.last.lng} (as of ${new Date(t.last.at).toLocaleTimeString('en-US',{timeZone:'America/New_York'})})` : 'location unknown';
const info = t => `${t.stand ? ' | Stand: ' + t.stand : ''}${t.vehicle ? ' | Vehicle: ' + t.vehicle : ''}${t.parking ? ' | Parked: ' + t.parking : ''}${t.gate ? ' | Gate: ' + t.gate : ''}${t.medical ? ' | Medical: ' + t.medical : ''}`;

// Start or update a trip: { id, name, contacts:[...], dueAt (ms), graceMin, stand, vehicle, parking, gate, medical, lat, lng }
app.post('/api/trip', (req, res) => { const t = req.body; if (!t.id) return res.status(400).end();
  trips[t.id] = { ...(trips[t.id] || {}), ...t, status: 'active', warned: false, alerted: false, last: t.lat ? { lat: t.lat, lng: t.lng, at: Date.now() } : (trips[t.id] || {}).last };
  save(); res.json({ ok: true, contacts: (t.contacts || []).map(consentStatus) }); });
app.post('/api/trip/:id/ping', (req, res) => { const t = trips[req.params.id]; if (!t) return res.status(404).end();
  t.last = { lat: req.body.lat, lng: req.body.lng, at: Date.now() }; (t.trail = t.trail || []).push([req.body.lat, req.body.lng]); t.trail = t.trail.slice(-500); save(); res.json({ ok: true }); });
app.post('/api/trip/:id/safe', async (req, res) => { const t = trips[req.params.id]; if (!t) return res.status(404).end();
  if (t.alerted) await sms(t.contacts, `StandSafe Update: ${t.name} has checked in safe. Please disregard the earlier alert. Reply STOP to opt out.`);
  t.status = 'done'; save(); res.json({ ok: true }); });
app.post('/api/trip/:id/extend', (req, res) => { const t = trips[req.params.id]; if (!t) return res.status(404).end();
  t.dueAt = Date.now() + (req.body.minutes || 30) * 60000; t.warned = false; save(); res.json({ ok: true, dueAt: t.dueAt }); });
app.post('/api/trip/:id/sos', async (req, res) => { const t = trips[req.params.id]; if (!t) return res.status(404).end();
  if (req.body.lat) t.last = { lat: req.body.lat, lng: req.body.lng, at: Date.now() };
  t.alerted = true; save(); await sms(t.contacts, `SOS from ${t.name} via StandSafe. GPS: ${loc(t)}${info(t)}. If you cannot reach them, call 911. Reply STOP to opt out.`); res.json({ ok: true }); });
app.get('/api/trip/:id', (req, res) => res.json(trips[req.params.id] || {}));
// Public SMS opt-in form endpoint (emergency contacts give consent here)
let optins = [];
app.post('/optin', async (req, res) => { const { name, phone, hunter, consent } = req.body || {};
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10 || !name) return res.status(400).json({ error: 'Name and a valid mobile number are required.' });
  const e164 = '+1' + digits.slice(-10), sms_ok = consent === true;
  optins.push({ name, phone: e164, hunter: hunter || '', smsConsent: sms_ok, at: new Date().toISOString(), ip: req.ip });
  await kvSet('optins', optins).catch(e => console.error('save optins failed', e.message));
  if (sms_ok) await sms([e164], "StandSafe: You're now an emergency contact. You'll only get texts if your hunter misses a check-in or presses SOS. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.", { skipConsent: true });
  res.json({ ok: true, smsConsent: sms_ok }); });
// App asks which contacts have opted in (requires app key)
app.post('/api/consent-check', (req, res) => res.json({ contacts: (req.body.contacts || []).map(consentStatus) }));
app.get('/', (_, res) => res.send('StandSafe server running' + (twilio ? ' | texting: on' : ' | texting: off (no Twilio keys)') + (pool ? ' | storage: database' : ' | storage: temporary files')));

// Every 30 seconds: check for missed check-ins.
setInterval(async () => { const now = Date.now();
  for (const t of Object.values(trips)) { if (t.status !== 'active') continue;
    const deadline = t.dueAt + (t.graceMin || 15) * 60000;
    if (!t.alerted && now > deadline) { t.alerted = true; save();
      await sms(t.contacts, `StandSafe Alert: ${t.name} did not check in from their hunt by ${new Date(t.dueAt).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'})}). Last GPS: ${loc(t)}${info(t)}. Try calling them. If you cannot reach them, call 911 and give these coordinates. Reply STOP to opt out.`); }
  } }, 30000);
(async () => {
  if (pool) await pool.query('CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL, updated_at timestamptz DEFAULT now())');
  trips = await kvGet('trips', fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : {});
  optins = await kvGet('optins', []);
  app.listen(PORT, () => console.log('StandSafe server on', PORT, twilio ? '(Twilio live)' : '(dry-run: no Twilio keys)', pool ? '(Neon database)' : '(local files - data lost on redeploy)'));
})().catch(e => { console.error('Startup failed', e); process.exit(1); });
