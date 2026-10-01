// StandSafe check-in server: keeps each hunter's timer and texts contacts via Twilio if they miss a check-in.
const express = require('express'), cors = require('cors'), fs = require('fs');
const app = express(); app.use(cors()); app.use(express.json({ limit: '1mb' }));
const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, APP_KEY, PORT = 8080 } = process.env;
const twilio = TWILIO_SID ? require('twilio')(TWILIO_SID, TWILIO_TOKEN) : null;
const DB = __dirname + '/trips.json';
let trips = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : {};
const save = () => fs.writeFileSync(DB, JSON.stringify(trips, null, 1));
app.use('/api', (req, res, next) => (!APP_KEY || req.get('x-app-key') === APP_KEY) ? next() : res.status(401).json({ error: 'bad key' }));

async function sms(to, body) {
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
  save(); res.json({ ok: true }); });
app.post('/api/trip/:id/ping', (req, res) => { const t = trips[req.params.id]; if (!t) return res.status(404).end();
  t.last = { lat: req.body.lat, lng: req.body.lng, at: Date.now() }; (t.trail = t.trail || []).push([req.body.lat, req.body.lng]); t.trail = t.trail.slice(-500); save(); res.json({ ok: true }); });
app.post('/api/trip/:id/safe', async (req, res) => { const t = trips[req.params.id]; if (!t) return res.status(404).end();
  if (t.alerted) await sms(t.contacts, `UPDATE: ${t.name} has checked in safe. Disregard the earlier alert.`);
  t.status = 'done'; save(); res.json({ ok: true }); });
app.post('/api/trip/:id/extend', (req, res) => { const t = trips[req.params.id]; if (!t) return res.status(404).end();
  t.dueAt = Date.now() + (req.body.minutes || 30) * 60000; t.warned = false; save(); res.json({ ok: true, dueAt: t.dueAt }); });
app.post('/api/trip/:id/sos', async (req, res) => { const t = trips[req.params.id]; if (!t) return res.status(404).end();
  if (req.body.lat) t.last = { lat: req.body.lat, lng: req.body.lng, at: Date.now() };
  t.alerted = true; save(); await sms(t.contacts, `SOS from ${t.name} via StandSafe. GPS: ${loc(t)}${info(t)}. Call 911 if you cannot reach them.`); res.json({ ok: true }); });
app.get('/api/trip/:id', (req, res) => res.json(trips[req.params.id] || {}));
app.get('/', (_, res) => res.send('StandSafe server running'));

// Every 30 seconds: check for missed check-ins.
setInterval(async () => { const now = Date.now();
  for (const t of Object.values(trips)) { if (t.status !== 'active') continue;
    const deadline = t.dueAt + (t.graceMin || 15) * 60000;
    if (!t.alerted && now > deadline) { t.alerted = true; save();
      await sms(t.contacts, `STANDSAFE ALERT: ${t.name} did not check in (due ${new Date(t.dueAt).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'})}). Last GPS: ${loc(t)}${info(t)}. Try calling them; if no answer, call 911 and give these coordinates.`); }
  } }, 30000);
app.listen(PORT, () => console.log('StandSafe server on', PORT, twilio ? '(Twilio live)' : '(dry-run: no Twilio keys)'));
