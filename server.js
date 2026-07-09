// =====================================================================
// BEAT MANAGEMENT SYSTEM — Hosted Digital Business Card Service
// Product:  Beat Management System (BMS)
// Made by:  Beat Digital Consult  ("Your Vision, Our Priority")
//
// This is the small, always-online companion service for the BMS
// Digital Business Card add-on. It gives every card a permanent
// public link. Scanning a card's QR code (or opening its link)
// always lands here — never on a phone-only file — so the profile
// is always live, always up to date, and works for absolutely
// anyone who scans it, with no app install required.
//
// It also acts as the central "switch" for the Digital Business
// Card package: Beat Digital Consult (the owner) approves or
// revokes the add-on per client license from the BMS desktop app,
// and every client's install checks in here to see whether their
// card package is currently active.
// =====================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Render/Railway/Fly (and virtually every PaaS) terminate TLS at a proxy
// in front of this app and forward the request as plain HTTP internally.
// Without this line, req.protocol always reports "http" — even for a
// visitor who came in over https — which produces broken
// "http://card.beatdigital.tech/..." links instead of "https://...".
// This tells Express to trust the proxy's X-Forwarded-Proto header.
app.set('trust proxy', 1);
app.use(express.json({ limit: '6mb' }));

// ---------------------------------------------------------------
// CORS — REQUIRED so the BMS desktop app (running from a file://
// or localhost page) is allowed to call this API from the browser.
// Without this, every save/sync request is silently blocked by the
// browser before it ever reaches this server — which looks exactly
// like "card not syncing" / "profile not found" when you scan it.
// ---------------------------------------------------------------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-license-key, x-admin-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'CHANGE-ME-BEFORE-DEPLOY';
const OWNER_LICENSE_KEY = 'BD-OWNER'; // sentinel used by the Beat Digital Consult install itself
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const BRAND = {
  product: 'Beat Management System',
  company: 'Beat Digital Consult',
  tagline: 'Your Vision, Our Priority',
  site: 'https://beatdigital.tech',
  supportEmail: 'admin@beatdigital.tech'
};

if (ADMIN_KEY === 'CHANGE-ME-BEFORE-DEPLOY') {
  console.warn('\n⚠️  WARNING: ADMIN_KEY environment variable is not set.');
  console.warn('   Set a strong ADMIN_KEY before going live — it protects the');
  console.warn('   Digital Card Package approval endpoints used by the owner app.\n');
}

// ---------------------------------------------------------------
// PERSISTENT DATABASE
// ---------------------------------------------------------------
// WHY THIS EXISTS: free-tier hosts (Render, Railway, Fly free plans)
// give this process an EPHEMERAL disk — it looks fine while the
// container is alive, but the instant it restarts (sleep/wake after
// idle, a redeploy, hitting the free memory limit, routine host
// recycling — all of which can happen every few minutes on a free
// plan) that disk is wiped and the server boots up empty. That is
// exactly what "card worked right after saving, then 'profile not
// found' a minute later" means — the data never left the container
// that just disappeared.
//
// The fix is to stop keeping the source of truth on that disk at
// all. If UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set
// (a free, always-on Redis database — https://upstash.com, no
// credit card required, data lives on Upstash's own servers and is
// NOT affected by this app's container restarting, sleeping, or
// redeploying), every card/staff-ID/package write is saved there
// immediately and durably. See README-DEPLOY.md → "PERMANENT
// STORAGE" for the 2-minute setup.
//
// If those env vars are not set, the service still runs (falls back
// to the local JSON file, same as before) so nothing breaks during
// local testing — but it prints a loud warning, and /healthz reports
// "persistent": false, because on a free host that fallback WILL
// lose data on the next restart.
// ---------------------------------------------------------------
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PERSISTENT = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_DB_KEY = 'bms:db:v1';

async function redisGet(key) {
  const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Upstash GET failed: HTTP ${res.status}`);
  const j = await res.json();
  return j.result; // null if not set, else a string
}
async function redisSet(key, value) {
  const res = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'text/plain' },
    body: value
  });
  if (!res.ok) throw new Error(`Upstash SET failed: HTTP ${res.status}`);
  return true;
}

function emptyDB() { return { cards: {}, packages: {}, staff: {} }; }

async function loadDB() {
  if (PERSISTENT) {
    try {
      const raw = await redisGet(REDIS_DB_KEY);
      if (!raw) return emptyDB();
      const parsed = JSON.parse(raw);
      return { cards: parsed.cards || {}, packages: parsed.packages || {}, staff: parsed.staff || {} };
    } catch (e) {
      console.error('Persistent DB load error (Upstash Redis):', e.message);
      // Do NOT silently fall back to an empty local DB here — that would look
      // exactly like the data-loss bug we're fixing. Fail loudly instead so
      // it's obvious this needs attention, but let the process still boot.
      return emptyDB();
    }
  }
  // ── Local file fallback (NOT durable across restarts on free hosts) ──
  try {
    if (!fs.existsSync(DB_PATH)) return emptyDB();
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return { cards: parsed.cards || {}, packages: parsed.packages || {}, staff: parsed.staff || {} };
  } catch (e) {
    console.error('DB load error, starting with an empty store:', e.message);
    return emptyDB();
  }
}

let DB = emptyDB(); // populated by loadDB() before app.listen() below

// Every call is awaited by its route handler before responding, so a
// save is confirmed durable (or the request is told it failed) before
// the client ever hears "ok" — no debounce window where a restart
// between the response and a delayed disk write could lose data.
async function saveDB() {
  if (PERSISTENT) {
    await redisSet(REDIS_DB_KEY, JSON.stringify(DB));
    return;
  }
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2));
  } catch (e) {
    console.error('DB save error:', e.message);
    throw e;
  }
}

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------
const CARD_THEMES = {
  navy: { label: 'Beat Navy', bg: 'linear-gradient(135deg,#0d0d63,#1e1eb8 55%,#2a2ad6)', accent: '#ff6b00', text: '#ffffff' },
  midnight: { label: 'Midnight', bg: 'linear-gradient(135deg,#0f172a,#1e293b)', accent: '#38bdf8', text: '#ffffff' },
  emerald: { label: 'Emerald', bg: 'linear-gradient(135deg,#053b2c,#059669)', accent: '#fde047', text: '#ffffff' },
  royal: { label: 'Royal Purple', bg: 'linear-gradient(135deg,#2e0a4e,#7e22ce)', accent: '#f472b6', text: '#ffffff' },
  charcoal: { label: 'Charcoal Gold', bg: 'linear-gradient(135deg,#1a1a1a,#3a3a3a)', accent: '#d4af37', text: '#ffffff' }
};

function esc(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key');
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing admin key.' });
  }
  next();
}

function buildVCard(card) {
  const v = s => (s || '').toString().replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const L = ['BEGIN:VCARD', 'VERSION:3.0'];
  L.push(`N:${v(card.lastName)};${v(card.firstName)};;;`);
  L.push(`FN:${v(card.fullName || ((card.firstName || '') + ' ' + (card.lastName || '')).trim())}`);
  if (card.company) L.push(`ORG:${v(card.company)}${card.department ? ';' + v(card.department) : ''}`);
  if (card.jobTitle) L.push(`TITLE:${v(card.jobTitle)}`);
  (card.phones || []).forEach(p => { if (p.number) L.push(`TEL;TYPE=${p.type || 'CELL'},VOICE:${v(p.number)}`); });
  (card.emails || []).forEach(e => { if (e) L.push(`EMAIL;TYPE=INTERNET:${v(e)}`); });
  if (card.website) L.push(`URL:${v(card.website)}`);
  if (card.address) L.push(`ADR;TYPE=WORK:;;${v(card.address)};;;;`);
  if (card.bio) L.push(`NOTE:${v(card.bio)}`);
  L.push('END:VCARD');
  return L.join('\r\n');
}

function newId() {
  return 'card_' + crypto.randomBytes(8).toString('hex');
}

function isPackageEnabled(licenseKey) {
  if (!licenseKey) return false;
  if (licenseKey === OWNER_LICENSE_KEY) return true; // Beat Digital's own demo cards always work
  const pkg = DB.packages[licenseKey];
  return !!(pkg && pkg.enabled);
}

// ---------------------------------------------------------------
// PUBLIC: service health / info page
// ---------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${BRAND.product} — Card Profile Service</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:Segoe UI,Arial,sans-serif;background:#0d0d63;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
  .box{max-width:460px}h1{margin:0 0 6px;font-size:22px}p{opacity:.85;font-size:14px;line-height:1.6}a{color:#ff6b00;font-weight:700;text-decoration:none}</style>
  </head><body><div class="box">
  <h1>🪪 ${BRAND.product}</h1>
  <p>Digital Business Card profile service — online and ready.<br>Every scanned card resolves to a live public profile here.</p>
  <p>Built &amp; owned by <a href="${BRAND.site}">${BRAND.company}</a></p>
  </div></body></html>`);
});

app.get('/healthz', (req, res) => res.json({
  ok: true, product: BRAND.product, company: BRAND.company,
  cards: Object.keys(DB.cards).length, staff: Object.keys(DB.staff).length,
  persistent: PERSISTENT,
  storage: PERSISTENT ? 'upstash-redis' : 'local-file (NOT durable on free hosts — see README-DEPLOY.md)'
}));

// ---------------------------------------------------------------
// CARD SYNC  (called by the BMS desktop app whenever a card is saved)
// ---------------------------------------------------------------
app.post('/api/cards', async (req, res) => {
  const licenseKey = req.get('x-license-key') || 'UNKNOWN';
  if (!isPackageEnabled(licenseKey)) {
    return res.status(403).json({ ok: false, error: 'Digital Business Card package is not active for this license. Ask Beat Digital Consult (or your account admin) to approve it.' });
  }
  const card = req.body || {};
  if (!card.id) card.id = newId();
  const existing = DB.cards[card.id] || {};
  DB.cards[card.id] = {
    ...existing,
    ...card,
    licenseKey,
    stats: existing.stats || { views: 0, saves: 0, shares: 0 },
    syncedAt: new Date().toISOString()
  };
  try {
    await saveDB();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Card received but the durable save failed — please retry: ' + e.message });
  }
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, id: card.id, url: `${base}/c/${card.id}`, persistent: PERSISTENT });
});

app.delete('/api/cards/:id', async (req, res) => {
  const licenseKey = req.get('x-license-key') || 'UNKNOWN';
  const c = DB.cards[req.params.id];
  if (c && c.licenseKey === licenseKey) {
    delete DB.cards[req.params.id];
    try { await saveDB(); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  res.json({ ok: true });
});

app.get('/api/cards/:id', (req, res) => {
  const c = DB.cards[req.params.id];
  if (!c) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, card: c });
});

// Client-side "beacon" call for save/share button clicks on the profile page
app.post('/api/cards/:id/track', async (req, res) => {
  const c = DB.cards[req.params.id];
  if (!c) return res.status(404).json({ ok: false });
  const type = ['views', 'saves', 'shares'].includes(req.body?.type) ? req.body.type : null;
  if (type) { c.stats[type] = (c.stats[type] || 0) + 1; try { await saveDB(); } catch (e) {} }
  res.json({ ok: true, stats: c.stats });
});

// ---------------------------------------------------------------
// PUBLIC PROFILE PAGE — this is what opens when anyone scans a card
// ---------------------------------------------------------------
app.get('/c/:id', async (req, res) => {
  const card = DB.cards[req.params.id];
  if (!card || card.privacy === 'private') {
    return res.status(404).send(notFoundPage());
  }
  card.stats = card.stats || { views: 0, saves: 0, shares: 0 };
  card.stats.views += 1;
  try { await saveDB(); } catch (e) { /* view counter is best-effort; never block the profile page on it */ }
  res.send(renderProfilePage(card, req));
});

app.get('/vcf/:id', async (req, res) => {
  const card = DB.cards[req.params.id];
  if (!card) return res.status(404).send('Not found');
  card.stats.saves = (card.stats.saves || 0) + 1;
  try { await saveDB(); } catch (e) {}
  const name = (card.fullName || `${card.firstName || ''} ${card.lastName || ''}`).trim() || 'contact';
  res.set('Content-Type', 'text/vcard');
  res.set('Content-Disposition', `attachment; filename="${name.replace(/\s+/g, '_')}.vcf"`);
  res.send(buildVCard(card));
});

// ---------------------------------------------------------------
// STAFF ID CARD VERIFICATION  (Premium ID Card QR codes link here)
// Not part of the paid Digital Business Card add-on — this is core
// Employee/Payroll functionality, so it is NOT gated by
// isPackageEnabled(). Any BMS install with an internet connection
// gets working, permanent ID verification links.
// ---------------------------------------------------------------
app.post('/api/staff', async (req, res) => {
  const licenseKey = req.get('x-license-key') || 'UNKNOWN';
  const staff = req.body || {};
  if (!staff.id) return res.status(400).json({ ok: false, error: 'id is required' });
  const existing = DB.staff[staff.id] || {};
  DB.staff[staff.id] = { ...existing, ...staff, licenseKey, syncedAt: new Date().toISOString() };
  try {
    await saveDB();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Staff record received but the durable save failed — please retry: ' + e.message });
  }
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, id: staff.id, url: `${base}/s/${staff.id}`, persistent: PERSISTENT });
});

app.delete('/api/staff/:id', async (req, res) => {
  const licenseKey = req.get('x-license-key') || 'UNKNOWN';
  const s = DB.staff[req.params.id];
  if (s && s.licenseKey === licenseKey) {
    delete DB.staff[req.params.id];
    try { await saveDB(); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  res.json({ ok: true });
});

app.get('/api/staff/:id', (req, res) => {
  const s = DB.staff[req.params.id];
  if (!s) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, staff: s });
});

app.get('/s/:id', (req, res) => {
  const s = DB.staff[req.params.id];
  if (!s) return res.status(404).send(notFoundPage());
  res.send(renderStaffProfilePage(s, req));
});

function notFoundPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Profile not found</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:Segoe UI,Arial,sans-serif;background:#f2f3f8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
  .box{max-width:380px}h1{font-size:20px;color:#222}p{color:#666;font-size:13.5px;line-height:1.6}</style>
  </head><body><div class="box"><h1>🔍 Profile not found</h1>
  <p>This card link is invalid, has been removed, or was set to private by its owner.</p>
  <p style="margin-top:18px;font-size:11.5px;color:#999">${BRAND.product} · ${BRAND.company}</p>
  </div></body></html>`;
}

function renderProfilePage(card, req) {
  const th = CARD_THEMES[card.theme] || CARD_THEMES.navy;
  const name = card.fullName || `${card.firstName || ''} ${card.lastName || ''}`.trim() || 'Contact';
  const base = `${req.protocol}://${req.get('host')}`;
  const phones = (card.phones || []).filter(p => p.number);
  const emails = (card.emails || []).filter(Boolean);
  const socials = [
    card.socials?.linkedin && ['LinkedIn', '🔗', card.socials.linkedin],
    card.socials?.instagram && ['Instagram', '📷', card.socials.instagram],
    card.socials?.facebook && ['Facebook', '📘', card.socials.facebook],
    card.socials?.twitter && ['X / Twitter', '✖️', card.socials.twitter],
    card.socials?.whatsapp && ['WhatsApp', '💬', 'https://wa.me/' + card.socials.whatsapp.replace(/[^0-9]/g, '')],
    card.socials?.tiktok && ['TikTok', '🎵', card.socials.tiktok]
  ].filter(Boolean);

  const rows = [];
  phones.forEach((p, i) => rows.push(`<a class="row" href="tel:${esc(p.number)}"><div class="ic">📞</div><div><div class="lbl">${esc(p.type || 'Phone')}</div><div class="val">${esc(p.number)}</div></div></a>`));
  emails.forEach(e => rows.push(`<a class="row" href="mailto:${esc(e)}"><div class="ic">✉️</div><div><div class="lbl">Email</div><div class="val">${esc(e)}</div></div></a>`));
  if (card.website) rows.push(`<a class="row" target="_blank" rel="noopener" href="${esc(card.website)}"><div class="ic">🌐</div><div><div class="lbl">Website</div><div class="val">${esc(card.website)}</div></div></a>`);
  if (card.address) rows.push(`<div class="row"><div class="ic">📍</div><div><div class="lbl">Address</div><div class="val">${esc(card.address)}</div></div></div>`);
  socials.forEach(([label, icon, url]) => rows.push(`<a class="row" target="_blank" rel="noopener" href="${esc(url)}"><div class="ic">${icon}</div><div><div class="lbl">${esc(label)}</div><div class="val">${esc(url)}</div></div></a>`));

  const waLink = card.socials?.whatsapp ? `https://wa.me/${card.socials.whatsapp.replace(/[^0-9]/g, '')}` : '';
  const firstPhone = phones[0]?.number || '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(name)} — Digital Business Card</title>
<meta property="og:title" content="${esc(name)}${card.company ? ' · ' + esc(card.company) : ''}">
<meta property="og:description" content="${esc(card.jobTitle || 'Digital Business Card')}">
${card.photoUrl ? `<meta property="og:image" content="${esc(card.photoUrl)}">` : ''}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Segoe UI,Arial,sans-serif;background:#f2f3f8;display:flex;justify-content:center;padding:26px 14px;min-height:100vh}
.wrap{width:100%;max-width:420px}
.hero{background:${th.bg};color:${th.text};border-radius:20px 20px 0 0;padding:34px 24px 26px;text-align:center;position:relative}
.photo{width:96px;height:96px;border-radius:50%;object-fit:cover;border:4px solid rgba(255,255,255,.65);margin-bottom:12px;background:rgba(255,255,255,.2)}
.ph-fallback{display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800}
.name{font-size:22px;font-weight:800}
.title{font-size:13.5px;opacity:.92;margin-top:3px}
.company{font-size:13.5px;opacity:.92;font-weight:700}
.body{background:#fff;border-radius:0 0 20px 20px;padding:22px 24px;box-shadow:0 10px 40px rgba(0,0,0,.12)}
.row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid #eee;text-decoration:none;color:#222}
.row:last-child{border-bottom:none}
.ic{width:34px;height:34px;border-radius:9px;background:${th.accent}22;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.lbl{font-size:10.5px;color:#888;text-transform:uppercase;letter-spacing:.4px}
.val{font-size:13.5px;font-weight:600;word-break:break-word}
.btnRow{display:flex;gap:10px;margin:18px 0 6px;flex-wrap:wrap}
.btn{flex:1;min-width:130px;text-align:center;padding:12px 10px;border-radius:10px;font-weight:700;font-size:13px;text-decoration:none;cursor:pointer;border:none;color:#111}
.btn.primary{background:${th.accent}}
.btn.outline{background:#f2f3f8;color:#222}
.bio{font-size:13px;color:#555;line-height:1.5;padding:14px 0;border-bottom:1px solid #eee}
.qrsec{text-align:center;margin-top:20px;padding-top:18px;border-top:1px dashed #ddd}
.foot{text-align:center;font-size:10.5px;color:#aaa;margin-top:16px}
.foot a{color:#888}
</style></head><body><div class="wrap">
<div class="hero">
  ${card.logoUrl ? `<img src="${esc(card.logoUrl)}" style="position:absolute;top:14px;right:14px;width:38px;height:38px;object-fit:contain;background:#fff;border-radius:8px;padding:3px">` : ''}
  ${card.photoUrl ? `<img class="photo" src="${esc(card.photoUrl)}">` : `<div class="photo ph-fallback">${esc(name.substring(0, 2).toUpperCase())}</div>`}
  <div class="name">${esc(name)}</div>
  ${card.jobTitle ? `<div class="title">${esc(card.jobTitle)}</div>` : ''}
  ${card.company ? `<div class="company">${esc(card.company)}</div>` : ''}
</div>
<div class="body">
  ${card.bio ? `<div class="bio">${esc(card.bio)}</div>` : ''}
  ${rows.join('')}
  <div class="btnRow">
    <button class="btn primary" onclick="saveContact()">💾 Save Contact</button>
    ${firstPhone ? `<a class="btn outline" href="tel:${esc(firstPhone)}">📞 Call</a>` : ''}
    ${waLink ? `<a class="btn outline" href="${waLink}" target="_blank" rel="noopener" onclick="track('shares')">💬 WhatsApp</a>` : ''}
    ${emails[0] ? `<a class="btn outline" href="mailto:${esc(emails[0])}">✉️ Email</a>` : ''}
  </div>
  <div class="qrsec">
    <div style="font-size:10.5px;color:#999">Viewed via secure link · ${BRAND.product}</div>
  </div>
</div>
<div class="foot">Digital Business Card by ${BRAND.company} · "${BRAND.tagline}"<br><a href="${BRAND.site}" target="_blank" rel="noopener">${BRAND.site.replace('https://', '')}</a></div>
</div>
<script>
function track(type){ try{ fetch('${base}/api/cards/${card.id}/track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:type})}); }catch(e){} }
function saveContact(){ track('saves'); window.location.href = '${base}/vcf/${card.id}'; }
</script>
</body></html>`;
}

function renderStaffProfilePage(s, req) {
  const active = s.status !== 'inactive' && !s.revoked;
  const statusLabel = active ? '✅ Verified Active Employee' : '⛔ No Longer Active';
  const statusColor = active ? '#059669' : '#dc2626';
  const statusBg = active ? '#d1fae5' : '#fee2e2';
  const waNumber = (s.socials?.whatsapp || s.phone || '').replace(/[^0-9]/g, '');
  const waLink = waNumber ? `https://wa.me/${waNumber}` : '';

  const contactRows = [];
  if (s.phone) contactRows.push(`<a class="row" href="tel:${esc(s.phone)}"><div class="ic">📞</div><div><div class="lbl">Phone</div><div class="val">${esc(s.phone)}</div></div></a>`);
  if (waLink) contactRows.push(`<a class="row" href="${waLink}" target="_blank" rel="noopener"><div class="ic">💬</div><div><div class="lbl">WhatsApp</div><div class="val">${esc(s.socials?.whatsapp || s.phone)}</div></div></a>`);
  if (s.email) contactRows.push(`<a class="row" href="mailto:${esc(s.email)}"><div class="ic">✉️</div><div><div class="lbl">Email</div><div class="val">${esc(s.email)}</div></div></a>`);

  const socialLinks = [
    s.socials?.linkedin && ['LinkedIn', '🔗', s.socials.linkedin],
    s.socials?.twitter && ['X / Twitter', '✖️', s.socials.twitter],
    s.socials?.instagram && ['Instagram', '📷', s.socials.instagram],
    s.socials?.facebook && ['Facebook', '📘', s.socials.facebook]
  ].filter(Boolean);
  const socialIcons = socialLinks.length ? `<div class="socialRow">${socialLinks.map(([label, icon, url]) => `<a class="social" title="${esc(label)}" href="${esc(url)}" target="_blank" rel="noopener">${icon}</a>`).join('')}</div>` : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(s.name)} — Employee Verification</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Segoe UI,Arial,sans-serif;background:#f2f3f8;display:flex;justify-content:center;padding:26px 14px;min-height:100vh}
.wrap{width:100%;max-width:400px}
.hero{background:linear-gradient(135deg,#0d0d63,#1e1eb8 55%,#2a2ad6);color:#fff;border-radius:20px 20px 0 0;padding:30px 24px 22px;text-align:center}
.photo{width:88px;height:88px;border-radius:50%;object-fit:cover;border:4px solid rgba(255,255,255,.65);margin-bottom:12px;background:rgba(255,255,255,.2)}
.ph-fallback{display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800}
.name{font-size:20px;font-weight:800}
.role{font-size:13px;opacity:.9;margin-top:3px}
.body{background:#fff;border-radius:0 0 20px 20px;padding:22px 24px;box-shadow:0 10px 40px rgba(0,0,0,.12)}
.status{text-align:center;padding:10px;border-radius:10px;font-weight:700;font-size:13px;margin-bottom:16px;background:${statusBg};color:${statusColor}}
.row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid #eee;text-decoration:none;color:#222}
.row:last-child{border-bottom:none}
.ic{width:34px;height:34px;border-radius:9px;background:#1e1eb822;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.lbl{font-size:10.5px;color:#888;text-transform:uppercase;letter-spacing:.4px}
.val{font-size:13.5px;font-weight:600;word-break:break-word}
.meta{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #eee;font-size:12.5px}
.meta span:first-child{color:#888}
.meta span:last-child{font-weight:700;color:#222}
.socialRow{display:flex;gap:10px;justify-content:center;margin:16px 0 4px}
.social{width:40px;height:40px;border-radius:50%;background:#f2f3f8;display:flex;align-items:center;justify-content:center;font-size:17px;text-decoration:none;color:#222}
.sectionTitle{font-size:10.5px;color:#999;text-transform:uppercase;letter-spacing:.5px;margin:18px 0 4px}
.foot{text-align:center;font-size:10.5px;color:#aaa;margin-top:16px}
</style></head><body><div class="wrap">
<div class="hero">
  ${s.photoUrl ? `<img class="photo" src="${esc(s.photoUrl)}">` : `<div class="photo ph-fallback">${esc((s.name || '').substring(0, 2).toUpperCase())}</div>`}
  <div class="name">${esc(s.name)}</div>
  <div class="role">${esc(s.role || '')}${s.dept ? ' · ' + esc(s.dept) : ''}</div>
</div>
<div class="body">
  <div class="status">${statusLabel}</div>
  <div class="meta"><span>Employee ID</span><span>${esc(s.idNumber || s.id)}</span></div>
  <div class="meta"><span>Company</span><span>${esc(s.companyName || BRAND.company)}</span></div>
  ${s.issuedAt ? `<div class="meta"><span>Issued</span><span>${esc(s.issuedAt)}</span></div>` : ''}
  ${s.validUntil ? `<div class="meta"><span>Valid Until</span><span>${esc(s.validUntil)}</span></div>` : ''}
  ${contactRows.length ? `<div class="sectionTitle">Contact</div>${contactRows.join('')}` : ''}
  ${socialIcons}
</div>
<div class="foot">Verified via ${BRAND.product} · ${BRAND.company}<br>This page updates automatically — it always reflects this employee's current status.</div>
</div></body></html>`;
}

// ---------------------------------------------------------------
// DIGITAL CARD PACKAGE — approval status (read, public per license)
// ---------------------------------------------------------------
app.get('/api/card-package/:licenseKey', (req, res) => {
  const licenseKey = req.params.licenseKey;
  const enabled = isPackageEnabled(licenseKey);
  const pkg = DB.packages[licenseKey] || {};
  res.json({ ok: true, licenseKey, enabled, price: pkg.price || null, notes: pkg.notes || '', approvedAt: pkg.approvedAt || null });
});

// ---------------------------------------------------------------
// ADMIN (Beat Digital Consult owner only — protected by ADMIN_KEY)
// ---------------------------------------------------------------
app.post('/api/admin/card-package', requireAdmin, async (req, res) => {
  const { licenseKey, enabled, price, notes, approvedBy } = req.body || {};
  if (!licenseKey) return res.status(400).json({ ok: false, error: 'licenseKey is required' });
  DB.packages[licenseKey] = {
    enabled: !!enabled,
    price: price || null,
    notes: notes || '',
    approvedBy: approvedBy || 'Beat Digital Consult',
    approvedAt: new Date().toISOString()
  };
  try { await saveDB(); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  res.json({ ok: true, package: DB.packages[licenseKey] });
});

app.get('/api/admin/card-packages', requireAdmin, (req, res) => {
  const cardCounts = {};
  Object.values(DB.cards).forEach(c => { cardCounts[c.licenseKey] = (cardCounts[c.licenseKey] || 0) + 1; });
  res.json({ ok: true, packages: DB.packages, cardCounts });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const cards = Object.values(DB.cards);
  res.json({
    ok: true,
    totalCards: cards.length,
    totalViews: cards.reduce((s, c) => s + (c.stats?.views || 0), 0),
    totalSaves: cards.reduce((s, c) => s + (c.stats?.saves || 0), 0),
    totalShares: cards.reduce((s, c) => s + (c.stats?.shares || 0), 0),
    packages: DB.packages
  });
});

app.use((req, res) => res.status(404).send(notFoundPage()));

// Load the database BEFORE accepting traffic — with Upstash this is a
// single fast round-trip; with the local-file fallback it's instant.
(async () => {
  DB = await loadDB();
  app.listen(PORT, () => {
    console.log(`\n🪪 ${BRAND.product} — Card Profile Service`);
    console.log(`   by ${BRAND.company} — running on port ${PORT}`);
    console.log(`   Health check: /healthz`);
    if (PERSISTENT) {
      console.log(`   ✅ Persistent storage: Upstash Redis — card & staff links will survive restarts.\n`);
    } else {
      console.log(`   ⚠️  Persistent storage: OFF (local file only).`);
      console.log(`   ⚠️  On a free host, cards/staff IDs saved now WILL disappear the next`);
      console.log(`   ⚠️  time this service restarts. Set UPSTASH_REDIS_REST_URL and`);
      console.log(`   ⚠️  UPSTASH_REDIS_REST_TOKEN to fix this permanently — see`);
      console.log(`   ⚠️  README-DEPLOY.md → "PERMANENT STORAGE".\n`);
    }
  });
})();
