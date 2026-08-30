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

const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

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
// BASIC SECURITY HEADERS (hand-rolled, no extra dependency — a
// production deploy could swap this for the `helmet` package, but
// this covers the essentials for a small service like this one)
// ---------------------------------------------------------------
app.use((req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ---------------------------------------------------------------
// RATE LIMITING (hand-rolled in-memory sliding window — good enough
// for a single-instance deploy on Render/Railway/Fly's free tiers;
// swap for a Redis-backed limiter if you ever run multiple instances)
// ---------------------------------------------------------------
function makeRateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> [timestamps]
  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);
    if (arr.length > max) {
      return res.status(429).json({ ok: false, error: 'Too many requests — please slow down and try again shortly.' });
    }
    next();
  };
}
// Generous limit for normal card scans/publishes, tighter for admin
// endpoints where hits should be rare and deliberate.
const publicLimiter = makeRateLimiter({ windowMs: 60 * 1000, max: 120 });
const adminLimiter = makeRateLimiter({ windowMs: 60 * 1000, max: 30 });
app.use('/api/admin', adminLimiter);
app.use(publicLimiter);

// ---------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
// If ADMIN_KEY isn't set in the environment, generate a strong random
// one for this boot instead of falling back to a fixed, guessable
// string. This closes the "forgot to set it" hole — a fixed default
// left in place would let anyone approve/revoke Digital Card
// packages for any client. A freshly-generated key still needs to be
// set as a persistent env var (it changes every restart otherwise,
// which will lock the owner app out of admin actions) — the boot log
// below prints it once, loudly, so it can be copied into Render/
// Railway/Fly's environment variable settings.
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(24).toString('hex');
const ADMIN_KEY_WAS_GENERATED = !process.env.ADMIN_KEY;
const MONGODB_URI = process.env.MONGODB_URI || '';
const OWNER_LICENSE_KEY = 'BD-OWNER'; // sentinel used by the Beat Digital Consult install itself
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const BRAND = {
  product: 'Beat Management System',
  company: 'Beat Digital Consult',
  tagline: 'Your Vision, Our Priority',
  site: 'https://beatdigital.tech',
  supportEmail: 'admin@beatdigital.tech'
};

if (ADMIN_KEY_WAS_GENERATED) {
  console.warn('\n⚠️  ADMIN_KEY environment variable is not set — generated a');
  console.warn('   temporary one for THIS BOOT ONLY (it will change on every');
  console.warn('   restart until you set it permanently):\n');
  console.warn(`   ADMIN_KEY=${ADMIN_KEY}\n`);
  console.warn('   Set this as a persistent environment variable on your host');
  console.warn('   (Render/Railway/Fly → Environment) and paste the SAME value');
  console.warn('   into the BMS desktop app under Settings → 🌐 Card Hosting.\n');
}

// ---------------------------------------------------------------
// PERSISTENCE
//
// IMPORTANT — READ THIS IF CARDS EVER "DISAPPEAR" OR SHOW
// "PROFILE NOT FOUND" AFTER WORKING FINE EARLIER:
//
// Render's FREE web service tier has a completely ephemeral
// filesystem — this is not a bug, it's documented Render
// behaviour, and free services CANNOT attach persistent disks at
// all (only paid services can). Render can also restart a free
// service at any time, and always wipes its local files on every
// restart, redeploy, or spin-down. If MONGODB_URI is not set, this
// server falls back to the local JSON file below — which means
// every card, every package approval, and every stat will be
// silently lost the next time Render restarts this service. That
// is almost certainly why cards work right after you resave them
// and then vanish a short time later.
//
// THE FIX: set MONGODB_URI (a free MongoDB Atlas cluster works
// great and never expires, unlike Render's free Postgres which
// expires after 30 days) — see README-DEPLOY.md for the exact
// steps. Once set, every card survives restarts, redeploys, and
// spin-downs, permanently, for free. For a commercial product you
// should also upgrade the Render web service itself to a paid
// Starter plan (~$7/mo) so it never spins down at all — see
// README-DEPLOY.md for why the free tier's 15-minute spin-down is
// still worth eliminating even once your data is safe.
// ---------------------------------------------------------------
let mongoCollection = null;

async function initMongo() {
  if (!MONGODB_URI) {
    console.warn('\n⚠️  MONGODB_URI is not set — using local file storage only.');
    console.warn('   On Render\'s free tier this means ALL CARDS WILL BE LOST on the');
    console.warn('   next restart/redeploy/spin-down. See README-DEPLOY.md → "Making');
    console.warn('   cards permanent" to fix this before going live with real clients.\n');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('beat_management_system');
    mongoCollection = db.collection('card_service_state');
    console.log('✅ Connected to MongoDB — cards will now persist permanently across restarts.');
  } catch (e) {
    console.error('\n⚠️  Could not connect to MongoDB:', e.message);
    console.error('   Falling back to local file storage (NOT persistent on Render free tier).');
    console.error('   Double-check MONGODB_URI is correct and that your Atlas cluster allows');
    console.error('   connections from anywhere (Network Access → 0.0.0.0/0) — see README-DEPLOY.md.\n');
    mongoCollection = null;
  }
}

async function loadDB() {
  if (mongoCollection) {
    try {
      const doc = await mongoCollection.findOne({ _id: 'db' });
      if (doc) return { cards: doc.cards || {}, packages: doc.packages || {}, auditLog: doc.auditLog || [], licenses: doc.licenses || {}, hubtelStatus: doc.hubtelStatus || {}, businessAuditLog: doc.businessAuditLog || [], portals: doc.portals || {}, surveys: doc.surveys || {}, surveyResponses: doc.surveyResponses || {}, teamChat: doc.teamChat || {}, recordComments: doc.recordComments || {} };
      return { cards: {}, packages: {}, auditLog: [], licenses: {}, hubtelStatus: {}, businessAuditLog: [], portals: {}, surveys: {}, surveyResponses: {}, teamChat: {}, recordComments: {} };
    } catch (e) {
      console.error('MongoDB load error, falling back to local file for this boot:', e.message);
    }
  }
  try {
    if (!fs.existsSync(DB_PATH)) return { cards: {}, packages: {}, auditLog: [], licenses: {}, hubtelStatus: {}, businessAuditLog: [], portals: {}, surveys: {}, surveyResponses: {}, teamChat: {}, recordComments: {} };
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return { cards: parsed.cards || {}, packages: parsed.packages || {}, auditLog: parsed.auditLog || [], licenses: parsed.licenses || {}, hubtelStatus: parsed.hubtelStatus || {}, businessAuditLog: parsed.businessAuditLog || [], portals: parsed.portals || {}, surveys: parsed.surveys || {}, surveyResponses: parsed.surveyResponses || {}, teamChat: parsed.teamChat || {}, recordComments: parsed.recordComments || {} };
  } catch (e) {
    console.error('DB load error, starting with an empty store:', e.message);
    return { cards: {}, packages: {}, auditLog: [], licenses: {}, hubtelStatus: {}, businessAuditLog: [], portals: {}, surveys: {}, surveyResponses: {}, teamChat: {}, recordComments: {} };
  }
}

let DB = { cards: {}, packages: {}, auditLog: [], licenses: {}, hubtelStatus: {}, businessAuditLog: [], portals: {}, surveys: {}, surveyResponses: {}, teamChat: {}, recordComments: {} }; // populated for real just before the server starts listening — see boot() below
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    // Always write the local file too — harmless, and it's an instant
    // fallback if Mongo has a hiccup on this particular boot.
    try {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2));
    } catch (e) {
      console.error('DB file save error:', e.message);
    }
    if (mongoCollection) {
      try {
        await mongoCollection.updateOne(
          { _id: 'db' },
          { $set: { cards: DB.cards, packages: DB.packages, auditLog: DB.auditLog || [], licenses: DB.licenses || {}, hubtelStatus: DB.hubtelStatus || {}, businessAuditLog: DB.businessAuditLog || [], portals: DB.portals || {}, surveys: DB.surveys || {}, surveyResponses: DB.surveyResponses || {}, teamChat: DB.teamChat || {}, recordComments: DB.recordComments || {}, updatedAt: new Date() } },
          { upsert: true }
        );
      } catch (e) {
        console.error('MongoDB save error (data is still safe in the local file for now):', e.message);
      }
    }
  }, 150);
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

app.get('/healthz', (req, res) => res.json({ ok: true, product: BRAND.product, company: BRAND.company, cards: Object.keys(DB.cards).length, storage: mongoCollection ? 'mongodb' : 'file-only (not persistent on Render free tier)' }));

// ---------------------------------------------------------------
// CARD SYNC  (called by the BMS desktop app whenever a card is saved)
// ---------------------------------------------------------------
// Basic shape/size validation — this is not a substitute for real
// per-user auth (see the note on isPackageEnabled/licenseKey below),
// but it stops obviously malformed or oversized payloads from being
// stored and served back to the public.
const CARD_FIELD_LIMITS = {
  firstName: 100, lastName: 100, fullName: 150, jobTitle: 150, company: 150,
  department: 100, bio: 1000, website: 500, address: 300
};
function validateCardPayload(card) {
  for (const [field, max] of Object.entries(CARD_FIELD_LIMITS)) {
    if (card[field] != null && String(card[field]).length > max) {
      return `Field "${field}" exceeds the maximum length of ${max} characters.`;
    }
  }
  if (card.phones && (!Array.isArray(card.phones) || card.phones.length > 10)) return 'Too many phone numbers.';
  if (card.emails && (!Array.isArray(card.emails) || card.emails.length > 10)) return 'Too many email addresses.';
  return null;
}

app.post('/api/cards', (req, res) => {
  const licenseKey = req.get('x-license-key') || 'UNKNOWN';
  if (!isPackageEnabled(licenseKey)) {
    return res.status(403).json({ ok: false, error: 'Digital Business Card package is not active for this license. Ask Beat Digital Consult (or your account admin) to approve it.' });
  }
  const card = req.body || {};
  const validationError = validateCardPayload(card);
  if (validationError) return res.status(400).json({ ok: false, error: validationError });

  // A card can only be updated by the license key that owns it — a
  // license key can't overwrite another license's existing card by
  // guessing/reusing its id.
  if (card.id && DB.cards[card.id] && DB.cards[card.id].licenseKey !== licenseKey) {
    return res.status(403).json({ ok: false, error: 'This card belongs to a different license.' });
  }

  if (!card.id) card.id = newId();
  const existing = DB.cards[card.id] || {};
  DB.cards[card.id] = {
    ...existing,
    ...card,
    licenseKey,
    stats: existing.stats || { views: 0, saves: 0, shares: 0 },
    syncedAt: new Date().toISOString()
  };
  saveDB();
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, id: card.id, url: `${base}/c/${card.id}` });
});

app.delete('/api/cards/:id', (req, res) => {
  const licenseKey = req.get('x-license-key') || 'UNKNOWN';
  const c = DB.cards[req.params.id];
  if (c && c.licenseKey === licenseKey) { delete DB.cards[req.params.id]; saveDB(); }
  res.json({ ok: true });
});

app.get('/api/cards/:id', (req, res) => {
  const c = DB.cards[req.params.id];
  if (!c) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, card: c });
});

// Client-side "beacon" call for save/share button clicks on the profile page
app.post('/api/cards/:id/track', (req, res) => {
  const c = DB.cards[req.params.id];
  if (!c) return res.status(404).json({ ok: false });
  const type = ['views', 'saves', 'shares'].includes(req.body?.type) ? req.body.type : null;
  if (type) { c.stats[type] = (c.stats[type] || 0) + 1; saveDB(); }
  res.json({ ok: true, stats: c.stats });
});

// ---------------------------------------------------------------
// PUBLIC PROFILE PAGE — this is what opens when anyone scans a card
// ---------------------------------------------------------------
app.get('/c/:id', (req, res) => {
  const card = DB.cards[req.params.id];
  if (!card || card.privacy === 'private') {
    return res.status(404).send(notFoundPage());
  }
  // ── SUSPENSION CHECK ──────────────────────────────────
  // A card (Digital Business Card OR a Premium ID Card's public
  // verification page — both are served from here) belongs to a
  // license key. If that license's Digital Card package has been
  // revoked since the card was published, the public page must stop
  // resolving immediately — a scanned QR/printed card should not go
  // on working for a client Beat Digital Consult has cut off. This
  // is checked live on every scan, not just at publish time.
  if (!isPackageEnabled(card.licenseKey)) {
    return res.status(403).send(suspendedPage());
  }
  card.stats = card.stats || { views: 0, saves: 0, shares: 0 };
  card.stats.views += 1;
  saveDB();
  res.send(renderProfilePage(card, req));
});

app.get('/vcf/:id', (req, res) => {
  const card = DB.cards[req.params.id];
  if (!card) return res.status(404).send('Not found');
  if (!isPackageEnabled(card.licenseKey)) {
    return res.status(403).send(suspendedPage());
  }
  card.stats.saves = (card.stats.saves || 0) + 1;
  saveDB();
  const name = (card.fullName || `${card.firstName || ''} ${card.lastName || ''}`).trim() || 'contact';
  res.set('Content-Type', 'text/vcard');
  res.set('Content-Disposition', `attachment; filename="${name.replace(/\s+/g, '_')}.vcf"`);
  res.send(buildVCard(card));
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

function suspendedPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Card suspended</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:Segoe UI,Arial,sans-serif;background:#f2f3f8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
  .box{max-width:380px}h1{font-size:20px;color:#b91c1c}p{color:#666;font-size:13.5px;line-height:1.6}</style>
  </head><body><div class="box"><h1>⏸️ This card is currently suspended</h1>
  <p>The Digital Card package for this account is not currently active, so this profile is temporarily unavailable. The card owner should contact ${BRAND.company} to reactivate it.</p>
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

  // ── Employee ID verification panel ──
  // Present only for cards published from the Premium ID Card
  // designer (card.idBadge is set). Gives anyone who scans a
  // printed staff ID an instant, always-current way to confirm the
  // holder is a real, currently-active employee — not just a
  // vCard-style contact block.
  const badge = card.idBadge;
  let verifyHtml = '';
  if (badge) {
    const isVerified = badge.status === 'verified';
    const badgeColor = isVerified ? '#16a34a' : '#dc2626';
    const badgeBg = isVerified ? '#dcfce7' : '#fee2e2';
    const badgeLabel = isVerified ? '✅ Verified Active Employee' : '⚠️ Not a Current Employee';
    verifyHtml = `
    <div class="verify">
      <div class="verify-pill" style="background:${badgeBg};color:${badgeColor}">${badgeLabel}</div>
      <div class="verify-grid">
        <div><span>Employee ID</span><strong>${esc(badge.idNumber||'—')}</strong></div>
        <div><span>Department</span><strong>${esc(badge.department||'—')}</strong></div>
        <div><span>Issued</span><strong>${esc(badge.issuedDate||'—')}</strong></div>
        <div><span>Valid Until</span><strong>${esc(badge.validUntil||'—')}</strong></div>
      </div>
    </div>`;
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(name)} — ${badge ? 'Employee Verification' : 'Digital Business Card'}</title>
<meta property="og:title" content="${esc(name)}${card.company ? ' · ' + esc(card.company) : ''}">
<meta property="og:description" content="${esc(card.jobTitle || (badge ? 'Employee ID Verification' : 'Digital Business Card'))}">
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
.verify{margin-bottom:16px}
.verify-pill{display:inline-block;font-size:12px;font-weight:800;padding:7px 14px;border-radius:999px;margin-bottom:12px}
.verify-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;background:#f7f7fb;border-radius:10px;padding:14px}
.verify-grid div{display:flex;flex-direction:column;gap:2px}
.verify-grid span{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.4px}
.verify-grid strong{font-size:13px;color:#222}
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
  ${verifyHtml}
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
<div class="foot">${badge ? 'Employee Verification' : 'Digital Business Card'} by ${BRAND.company} · "${BRAND.tagline}"<br><a href="${BRAND.site}" target="_blank" rel="noopener">${BRAND.site.replace('https://', '')}</a></div>
</div>
<script>
function track(type){ try{ fetch('${base}/api/cards/${card.id}/track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:type})}); }catch(e){} }
function saveContact(){ track('saves'); window.location.href = '${base}/vcf/${card.id}'; }
</script>
</body></html>`;
}

// ---------------------------------------------------------------
// LICENSE REGISTRY — server-authoritative seat/device enforcement
//
// WHY THIS EXISTS: the BMS desktop app previously enforced its
// "1 license = 1 computer" rule entirely inside the client's own
// browser (localStorage). Anyone with DevTools open on their own
// machine could edit that data directly and bypass the limit — no
// server was ever checked. This registry is the fix: it's the one
// place a technical client CAN'T simply edit their way around,
// because it runs on a machine they don't control. The desktop app
// now calls /api/license/:key/checkin on every activation, sign-in,
// and roughly once a minute while a client session is open, and
// trusts THIS server's verdict over anything in its own storage.
//
// This raises the bar a lot — it can't be beaten by editing
// localStorage anymore — but it isn't absolute: someone could still
// intercept/patch the network call itself in a modified client.
// True tamper-proofing of a fully client-controlled desktop app
// isn't achievable; this closes the specific, easy bypass.
// ---------------------------------------------------------------
const PLAN_CODES = { S: 'starter', P: 'professional', E: 'enterprise', L: 'lifetime' };

function parseLicenseKey(key) {
  const parts = (key || '').trim().toUpperCase().split('-');
  // BDC-{plan}-XXXXX (×10 groups) = 12 parts, 50 random characters.
  // Kept in lockstep with License.generateKey/validateKey/activateKey
  // in beat-bms/js/auth.js — all three must agree on the key shape,
  // or activation succeeds on one side and fails on the other.
  if (parts.length !== 12 || parts[0] !== 'BDC') return null;
  const plan = PLAN_CODES[parts[1]];
  if (!plan) return null;
  return { key: parts.join('-'), plan };
}

function licenseStatusOf(lic) {
  if (!lic) return 'not-found';
  if (lic.status !== 'active') return lic.status;
  if (lic.expiresAt && new Date(lic.expiresAt) < new Date()) return 'expired';
  return 'active';
}

// Public: activation / ongoing sign-in verification. Rate-limited by
// the general publicLimiter above. No admin key needed — a license
// key by itself only proves you know the key, not that you're the
// owner, so this endpoint deliberately can't do anything an admin
// key can (revoke, change plan, etc.) — it can only check in a device
// against seats that were already provisioned by the owner.
app.post('/api/license/:key/checkin', (req, res) => {
  const parsed = parseLicenseKey(req.params.key);
  if (!parsed) return res.status(400).json({ ok: false, error: 'Invalid license key format.' });
  const { deviceId, deviceLabel } = req.body || {};
  if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId is required.' });

  const lic = DB.licenses[parsed.key];
  const status = licenseStatusOf(lic);
  if (status === 'not-found') return res.status(404).json({ ok: false, found: false, error: 'License key not found. Contact admin@beatdigital.tech.' });
  if (status === 'revoked') return res.status(403).json({ ok: false, found: true, status, error: 'This license has been revoked. Contact admin@beatdigital.tech.' });
  if (status === 'expired') return res.status(403).json({ ok: false, found: true, status, error: 'This license has expired. Contact admin@beatdigital.tech to renew.' });

  lic.activations = lic.activations || [];
  const already = lic.activations.find(a => a.deviceId === deviceId);
  if (already) {
    already.lastSeenAt = new Date().toISOString();
    saveDB();
    return res.json({ ok: true, found: true, status: 'active', plan: lic.plan, maxInstalls: lic.maxInstalls, expiresAt: lic.expiresAt, claimed: false });
  }

  if (lic.activations.length >= (lic.maxInstalls || 1)) {
    const activatedOn = lic.activations.map(a => a.deviceLabel || a.deviceId).join(', ');
    return res.status(403).json({
      ok: false, found: true, status: 'seat-limit',
      error: `This license key is already activated on ${lic.activations.length} computer(s) (max: ${lic.maxInstalls || 1}). A license key can only be used on one computer at a time. Ask Beat Digital Consult to transfer it before signing in on this device.`,
      activatedOn
    });
  }

  lic.activations.push({ deviceId, deviceLabel: deviceLabel || 'Unknown device', activatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() });
  DB.auditLog = DB.auditLog || [];
  DB.auditLog.unshift({ at: new Date().toISOString(), action: 'device-checkin', licenseKey: parsed.key, deviceId, deviceLabel });
  DB.auditLog = DB.auditLog.slice(0, 500);
  saveDB();
  res.json({ ok: true, found: true, status: 'active', plan: lic.plan, maxInstalls: lic.maxInstalls, expiresAt: lic.expiresAt, claimed: true });
});

// Admin: provision / update a license record. The owner app calls
// this right after generating a key locally, so a brand-new client
// machine (whose local storage has never heard of this key) has
// something authoritative to check in against.
app.post('/api/admin/licenses', requireAdmin, (req, res) => {
  const { key, businessName, plan, maxInstalls, expiresAt } = req.body || {};
  const parsed = parseLicenseKey(key);
  if (!parsed) return res.status(400).json({ ok: false, error: 'Invalid license key format.' });
  const existing = DB.licenses[parsed.key];
  DB.licenses[parsed.key] = {
    key: parsed.key,
    businessName: businessName || existing?.businessName || '',
    plan: plan || existing?.plan || parsed.plan,
    maxInstalls: maxInstalls || existing?.maxInstalls || 1,
    status: existing?.status || 'active',
    expiresAt: expiresAt !== undefined ? expiresAt : (existing?.expiresAt || null),
    activations: existing?.activations || [],
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  DB.auditLog = DB.auditLog || [];
  DB.auditLog.unshift({ at: new Date().toISOString(), action: existing ? 'license-update' : 'license-create', licenseKey: parsed.key });
  DB.auditLog = DB.auditLog.slice(0, 500);
  saveDB();
  res.json({ ok: true, license: DB.licenses[parsed.key] });
});

app.post('/api/admin/licenses/:key/revoke', requireAdmin, (req, res) => {
  const parsed = parseLicenseKey(req.params.key);
  if (!parsed || !DB.licenses[parsed.key]) return res.status(404).json({ ok: false, error: 'License not found on server.' });
  DB.licenses[parsed.key].status = 'revoked';
  DB.licenses[parsed.key].updatedAt = new Date().toISOString();
  DB.auditLog = DB.auditLog || [];
  DB.auditLog.unshift({ at: new Date().toISOString(), action: 'license-revoke', licenseKey: parsed.key });
  DB.auditLog = DB.auditLog.slice(0, 500);
  saveDB();
  res.json({ ok: true, license: DB.licenses[parsed.key] });
});

app.post('/api/admin/licenses/:key/reactivate', requireAdmin, (req, res) => {
  const parsed = parseLicenseKey(req.params.key);
  if (!parsed || !DB.licenses[parsed.key]) return res.status(404).json({ ok: false, error: 'License not found on server.' });
  DB.licenses[parsed.key].status = 'active';
  DB.licenses[parsed.key].updatedAt = new Date().toISOString();
  DB.auditLog = DB.auditLog || [];
  DB.auditLog.unshift({ at: new Date().toISOString(), action: 'license-reactivate', licenseKey: parsed.key });
  DB.auditLog = DB.auditLog.slice(0, 500);
  saveDB();
  res.json({ ok: true, license: DB.licenses[parsed.key] });
});

// Clears every activated device for this key so the client can check
// in fresh on a new computer — the server-side counterpart to the
// owner app's "Transfer License" button.
app.post('/api/admin/licenses/:key/transfer', requireAdmin, (req, res) => {
  const parsed = parseLicenseKey(req.params.key);
  if (!parsed || !DB.licenses[parsed.key]) return res.status(404).json({ ok: false, error: 'License not found on server.' });
  DB.licenses[parsed.key].activations = [];
  DB.licenses[parsed.key].updatedAt = new Date().toISOString();
  DB.auditLog = DB.auditLog || [];
  DB.auditLog.unshift({ at: new Date().toISOString(), action: 'license-transfer', licenseKey: parsed.key });
  DB.auditLog = DB.auditLog.slice(0, 500);
  saveDB();
  res.json({ ok: true, license: DB.licenses[parsed.key] });
});

app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  res.json({ ok: true, licenses: DB.licenses });
});

// Permanently removes a license record from the server, as opposed to
// /revoke which only flips its status. Without this, a key the owner
// deletes locally still lives on in DB.licenses forever — and the next
// background sync (which pulls every server-known key back into local
// storage) resurrects it right after deletion.
app.delete('/api/admin/licenses/:key', requireAdmin, (req, res) => {
  const parsed = parseLicenseKey(req.params.key);
  if (!parsed || !DB.licenses[parsed.key]) return res.status(404).json({ ok: false, error: 'License not found on server.' });
  delete DB.licenses[parsed.key];
  DB.auditLog = DB.auditLog || [];
  DB.auditLog.unshift({ at: new Date().toISOString(), action: 'license-delete', licenseKey: parsed.key });
  DB.auditLog = DB.auditLog.slice(0, 500);
  saveDB();
  res.json({ ok: true });
});

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
app.post('/api/admin/card-package', requireAdmin, (req, res) => {
  const { licenseKey, enabled, price, notes, approvedBy } = req.body || {};
  if (!licenseKey) return res.status(400).json({ ok: false, error: 'licenseKey is required' });
  const before = DB.packages[licenseKey] || null;
  DB.packages[licenseKey] = {
    enabled: !!enabled,
    price: price || null,
    notes: notes || '',
    approvedBy: approvedBy || 'Beat Digital Consult',
    approvedAt: new Date().toISOString()
  };
  DB.auditLog = DB.auditLog || [];
  DB.auditLog.unshift({
    at: new Date().toISOString(),
    action: enabled ? 'approve' : 'revoke',
    licenseKey,
    before,
    after: DB.packages[licenseKey]
  });
  DB.auditLog = DB.auditLog.slice(0, 500); // keep this bounded
  saveDB();
  res.json({ ok: true, package: DB.packages[licenseKey] });
});

// Read-only audit trail of package approvals/revocations (owner only)
app.get('/api/admin/audit-log', requireAdmin, (req, res) => {
  res.json({ ok: true, auditLog: DB.auditLog || [] });
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

// =====================================================================
// AI BUSINESS PROPOSAL GENERATOR
// Proxies to Anthropic's Messages API using a key that lives ONLY on
// this server (ANTHROPIC_API_KEY env var) — never exposed to the
// browser. This is why proposal generation goes through this backend
// instead of calling Anthropic directly from BMS: a secret key must
// never sit in client-side JS, and Anthropic's API isn't reachable
// from a browser origin anyway (no CORS for direct browser calls).
// =====================================================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const aiLimiter = makeRateLimiter({ windowMs: 60 * 1000, max: 8 }); // generation is relatively expensive — keep it tight
app.use('/api/ai', aiLimiter);

app.post('/api/ai/proposal', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ ok: false, error: 'AI proposal generation is not configured on this server yet. The site owner needs to set the ANTHROPIC_API_KEY environment variable — see README-DEPLOY.md.' });
  }
  const {
    companyName = '', clientName = '', projectTitle = '', industry = '',
    scope = '', deliverables = '', budget = '', currency = 'GHS',
    timeline = '', tone = 'professional', extraNotes = ''
  } = req.body || {};

  if (!clientName || !projectTitle || !scope) {
    return res.status(400).json({ ok: false, error: 'clientName, projectTitle and scope are required.' });
  }

  const prompt = `You are a senior business consultant writing a polished, persuasive, client-ready business proposal for a services company. Write in a ${tone} tone.

COMPANY SENDING THE PROPOSAL: ${companyName || 'Our company'}
CLIENT / PROSPECT: ${clientName}
INDUSTRY / CONTEXT: ${industry || 'not specified'}
PROJECT TITLE: ${projectTitle}
SCOPE OF WORK (as described by the sender): ${scope}
KEY DELIVERABLES (if provided): ${deliverables || 'infer sensible deliverables from the scope'}
BUDGET: ${budget ? `${currency} ${budget}` : 'not specified — do not invent a figure, describe pricing as "detailed in the attached quotation" instead'}
TIMELINE: ${timeline || 'not specified — propose a reasonable phased timeline'}
ADDITIONAL NOTES: ${extraNotes || 'none'}

Structure the proposal with these sections, using clear markdown headings (##):
1. Executive Summary
2. Understanding Your Needs (show you understand the client's problem/goal)
3. Proposed Solution / Scope of Work
4. Deliverables
5. Timeline (a simple phased breakdown)
6. Investment (reference the budget only if one was given; otherwise say pricing is detailed separately)
7. Why [Company Name] (2-3 concise, credible reasons — no invented statistics, awards, or client names)
8. Next Steps (a clear call to action)

Rules: Do not invent client testimonials, past client names, statistics, or certifications. Keep it concise, confident and specific to what was provided — expand professionally on the given scope rather than padding with generic filler. Output ONLY the proposal content in markdown, no preamble or meta-commentary.`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2200,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => '');
      console.error('Anthropic API error:', aiRes.status, errText);
      return res.status(502).json({ ok: false, error: 'The AI service returned an error. Please try again shortly.' });
    }
    const data = await aiRes.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!text) return res.status(502).json({ ok: false, error: 'The AI service returned an empty response.' });
    res.json({ ok: true, proposal: text });
  } catch (e) {
    console.error('AI proposal generation failed:', e.message);
    res.status(500).json({ ok: false, error: 'Could not reach the AI service. Check the server has outbound internet access.' });
  }
});

// =====================================================================
// EMAIL SENDING (SMTP or SendGrid)
// The tenant's own credentials are sent WITH each request (the same
// trust model BMS already uses for the admin key) and are never
// stored on this server — they live only in the tenant's own BMS
// Settings (browser localStorage) and pass through per-request.
// =====================================================================
const emailLimiter = makeRateLimiter({ windowMs: 60 * 1000, max: 20 });
app.use('/api/email', emailLimiter);

app.post('/api/email/send', async (req, res) => {
  const { provider, smtp, sendgridApiKey, from, fromName, to, subject, text, html } = req.body || {};
  if (!to || !subject || !(text || html)) {
    return res.status(400).json({ ok: false, error: 'to, subject and text/html are required.' });
  }
  try {
    if (provider === 'sendgrid') {
      if (!sendgridApiKey) return res.status(400).json({ ok: false, error: 'SendGrid API key missing. Add it in Settings → Notifications.' });
      const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sendgridApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from, name: fromName || undefined },
          subject,
          content: [{ type: html ? 'text/html' : 'text/plain', value: html || text }]
        })
      });
      if (!sgRes.ok) {
        const errText = await sgRes.text().catch(() => '');
        console.error('SendGrid error:', sgRes.status, errText);
        return res.status(502).json({ ok: false, error: 'SendGrid rejected the email — check the API key and verified sender address.' });
      }
      return res.json({ ok: true });
    }

    if (provider === 'smtp') {
      if (!smtp || !smtp.host || !smtp.user || !smtp.pass) {
        return res.status(400).json({ ok: false, error: 'SMTP host/user/pass missing. Add them in Settings → Notifications.' });
      }
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port || 587,
        secure: !!smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass }
      });
      await transporter.sendMail({
        from: fromName ? `"${fromName}" <${from || smtp.user}>` : (from || smtp.user),
        to, subject, text, html
      });
      return res.json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown email provider — expected "smtp" or "sendgrid".' });
  } catch (e) {
    console.error('Email send failed:', e.message);
    res.status(500).json({ ok: false, error: 'Could not send the email: ' + e.message });
  }
});

// =====================================================================
// PAYMENT GATEWAYS — Paystack, Hubtel, ExpressPay (Ghana)
// As with email, each tenant's own secret/API keys travel WITH the
// request from their own BMS Settings and are never stored here.
// These call the providers' real, documented REST APIs — a live
// merchant account + keys from the provider are required to use them.
// =====================================================================
const payLimiter = makeRateLimiter({ windowMs: 60 * 1000, max: 30 });
app.use('/api/payments', payLimiter);

// ── Paystack ──
app.post('/api/payments/paystack/initialize', async (req, res) => {
  const { secretKey, email, amount, currency = 'GHS', reference, callbackUrl } = req.body || {};
  if (!secretKey || !email || !amount || !reference) return res.status(400).json({ ok: false, error: 'secretKey, email, amount and reference are required.' });
  try {
    const r = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, amount: Math.round(amount * 100), currency, reference, callback_url: callbackUrl })
    });
    const data = await r.json();
    if (!data.status) return res.status(502).json({ ok: false, error: data.message || 'Paystack rejected the request.' });
    res.json({ ok: true, authorizationUrl: data.data.authorization_url, reference: data.data.reference });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/payments/paystack/verify/:reference', async (req, res) => {
  const secretKey = req.get('x-secret-key');
  if (!secretKey) return res.status(400).json({ ok: false, error: 'x-secret-key header required.' });
  try {
    const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(req.params.reference)}`, {
      headers: { Authorization: `Bearer ${secretKey}` }
    });
    const data = await r.json();
    if (!data.status) return res.status(502).json({ ok: false, error: data.message || 'Could not verify transaction.' });
    res.json({ ok: true, status: data.data.status, amount: data.data.amount / 100, currency: data.data.currency, paidAt: data.data.paid_at });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Hubtel Online Checkout ──
app.post('/api/payments/hubtel/initiate', async (req, res) => {
  const { clientId, clientSecret, merchantAccountNumber, amount, description, clientReference, callbackUrl, returnUrl, cancellationUrl } = req.body || {};
  if (!clientId || !clientSecret || !merchantAccountNumber || !amount || !clientReference) {
    return res.status(400).json({ ok: false, error: 'clientId, clientSecret, merchantAccountNumber, amount and clientReference are required.' });
  }
  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch('https://payproxyapi.hubtel.com/items/initiate', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalAmount: amount,
        description: description || 'Invoice payment',
        callbackUrl, returnUrl, cancellationUrl,
        merchantAccountNumber, clientReference
      })
    });
    const data = await r.json();
    if (!data.data || !data.data.checkoutUrl) return res.status(502).json({ ok: false, error: data.message || 'Hubtel rejected the request.' });
    res.json({ ok: true, checkoutUrl: data.data.checkoutUrl, checkoutId: data.data.checkoutId });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Hubtel posts a server-to-server callback here once the customer completes
// (or abandons) payment. We stash the last-known status per clientReference
// so the BMS app can poll GET /status/:reference from the browser.
app.post('/api/payments/hubtel/callback', (req, res) => {
  const body = req.body || {};
  const ref = body.ClientReference || body.clientReference || body.Data?.ClientReference;
  if (ref) {
    DB.hubtelStatus = DB.hubtelStatus || {};
    DB.hubtelStatus[ref] = { ...body, receivedAt: new Date().toISOString() };
    saveDB();
  }
  res.sendStatus(200);
});
app.get('/api/payments/hubtel/status/:reference', (req, res) => {
  const rec = (DB.hubtelStatus || {})[req.params.reference];
  res.json({ ok: true, found: !!rec, status: rec || null });
});

// ── ExpressPay Ghana (Dynamic Invoice API) ──
app.post('/api/payments/expresspay/initiate', async (req, res) => {
  const { merchantId, apiKey, amount, accountNumber, merchantReference, description, redirectUrl, postUrl, sandbox } = req.body || {};
  if (!merchantId || !apiKey || !amount || !merchantReference) {
    return res.status(400).json({ ok: false, error: 'merchantId, apiKey, amount and merchantReference are required.' });
  }
  try {
    const base = sandbox ? 'https://sandbox.expresspaygh.com' : 'https://expresspaygh.com';
    const params = new URLSearchParams({
      'merchant-id': merchantId, 'api-key': apiKey, amount: String(amount),
      accountnumber: accountNumber || '', 'merchant-reference': merchantReference,
      description: description || 'Invoice payment',
      'redirect-url': redirectUrl || '', 'post-url': postUrl || ''
    });
    const r = await fetch(`${base}/expresspay/api/dynamic-invoice.php`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params
    });
    const data = await r.json();
    if (data.status !== 1) return res.status(502).json({ ok: false, error: data.message || 'ExpressPay rejected the request.' });
    res.json({ ok: true, checkoutUrl: data.url });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// =====================================================================
// GENERAL BUSINESS AUDIT LOG
// Best-effort trail of significant actions taken inside the main BMS
// app (client created, invoice paid, payroll run, settings changed…).
// The app posts events here opportunistically when online; nothing
// blocks on it, and the full authoritative log always also lives in
// the tenant's own browser (Settings → Security → Audit Log) since
// this app is designed to keep working fully offline.
// =====================================================================
app.post('/api/audit', (req, res) => {
  const { licenseKey, actor, action, details } = req.body || {};
  if (!licenseKey || !action) return res.status(400).json({ ok: false, error: 'licenseKey and action are required.' });
  DB.businessAuditLog = DB.businessAuditLog || [];
  DB.businessAuditLog.unshift({ at: new Date().toISOString(), licenseKey, actor: actor || 'unknown', action, details: details || null });
  DB.businessAuditLog = DB.businessAuditLog.slice(0, 5000);
  saveDB();
  res.json({ ok: true });
});
app.get('/api/admin/business-audit-log', requireAdmin, (req, res) => {
  const { licenseKey } = req.query;
  let log = DB.businessAuditLog || [];
  if (licenseKey) log = log.filter(l => l.licenseKey === licenseKey);
  res.json({ ok: true, auditLog: log.slice(0, 500) });
});

// =====================================================================
// CUSTOMER SELF-SERVICE PORTAL — a tenant publishes a read-only snapshot
// of one invoice (never the whole dataset) for their client to view and
// pay online. Same trust model as Digital Business Cards: license key
// owns what it publishes, nothing else is ever exposed.
// =====================================================================
app.post('/api/portal/publish', (req, res) => {
  const licenseKey = req.get('x-license-key') || 'UNKNOWN';
  const snapshot = req.body || {};
  if (!snapshot.invoiceId || !snapshot.total) return res.status(400).json({ ok: false, error: 'invoiceId and total are required.' });
  const id = snapshot.publicId && DB.portals[snapshot.publicId]?.licenseKey === licenseKey ? snapshot.publicId : newId();
  DB.portals[id] = { ...snapshot, licenseKey, publishedAt: new Date().toISOString() };
  saveDB();
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, id, url: `${base}/portal/${id}` });
});
app.get('/portal/:id', (req, res) => {
  const p = DB.portals[req.params.id];
  if (!p) return res.status(404).send(notFoundPage());
  const paidBadge = p.status === 'paid' ? '<span style="background:#16a34a;color:#fff;padding:4px 12px;border-radius:20px;font-size:13px">✅ Paid</span>'
    : `<span style="background:#f59e0b;color:#fff;padding:4px 12px;border-radius:20px;font-size:13px">⏳ ${p.status||'Awaiting Payment'}</span>`;
  const itemsHtml = (p.items || []).map(it => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${it.desc||it.description||''}</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${p.currencySymbol||'₵'}${(it.total||it.amount||0).toLocaleString()}</td></tr>`).join('');
  const payButtons = (p.balance > 0 && p.paystackPublicKey) ? `
    <button onclick="payWithPaystack()" style="background:#0ea5e9;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:15px;cursor:pointer;margin-top:16px">💳 Pay Now — ${p.currencySymbol||'₵'}${p.balance.toLocaleString()}</button>
    <script src="https://js.paystack.co/v1/inline.js"></script>
    <script>
      function payWithPaystack(){
        const handler = PaystackPop.setup({
          key: '${p.paystackPublicKey}', email: '${(p.clientEmail||'customer@example.com').replace(/'/g,"")}',
          amount: ${Math.round((p.balance||0)*100)}, currency: '${p.currency||'GHS'}',
          ref: 'PORTAL-${p.invoiceId}-'+Date.now(),
          callback: function(r){ fetch('/api/payments/paystack/verify/'+r.reference).then(x=>x.json()).then(()=>{ alert('Payment received — thank you!'); location.reload(); }); },
          onClose: function(){}
        });
        handler.openIframe();
      }
    </script>` : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Invoice ${p.invoiceId} — ${p.businessName||''}</title>
    <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;padding:24px}
    .card{max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.06)}
    h1{font-size:20px;margin:0 0 4px}.muted{color:#64748b;font-size:13px}table{width:100%;border-collapse:collapse;margin-top:16px}</style></head>
    <body><div class="card">
      <h1>${p.businessName||'Invoice'}</h1><div class="muted">Invoice ${p.invoiceId} · ${p.clientName||''}</div>
      <div style="margin-top:12px">${paidBadge}</div>
      <table>${itemsHtml}<tr><td style="padding-top:12px;font-weight:700">Total</td><td style="padding-top:12px;font-weight:700;text-align:right">${p.currencySymbol||'₵'}${(p.total||0).toLocaleString()}</td></tr></table>
      ${payButtons}
      <div class="muted" style="margin-top:20px">Powered by BMS — Beat Digital Consult</div>
    </div></body></html>`);
});

// =====================================================================
// NPS / SATISFACTION SURVEYS — publish a question, collect anonymous
// (or client-named) responses on a public page, tenant pulls them back
// into their own local BMS via the sync endpoint below.
// =====================================================================
app.post('/api/survey/publish', (req, res) => {
  const licenseKey = req.get('x-license-key') || 'UNKNOWN';
  const { id, title, question } = req.body || {};
  if (!id || !question) return res.status(400).json({ ok: false, error: 'id and question are required.' });
  DB.surveys[id] = { id, title, question, licenseKey, publishedAt: new Date().toISOString() };
  saveDB();
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, url: `${base}/survey/${id}` });
});
app.get('/survey/:id', (req, res) => {
  const s = DB.surveys[req.params.id];
  if (!s) return res.status(404).send(notFoundPage());
  const clientName = (req.query.client || '').toString().slice(0, 100);
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${s.title||'Quick Survey'}</title>
    <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;padding:24px}
    .card{max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.06)}
    .scale{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0}.scale button{width:38px;height:38px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;font-weight:600}
    .scale button.sel{background:#0ea5e9;color:#fff;border-color:#0ea5e9}
    textarea{width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-family:inherit;margin-top:10px}
    button.submit{background:#16a34a;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:15px;cursor:pointer;margin-top:14px}</style></head>
    <body><div class="card">
      <h2>${s.title||'Quick Survey'}</h2><p>${s.question}</p>
      <div class="scale" id="scale">${Array.from({length:11},(_,i)=>`<button onclick="pick(${i})" data-v="${i}">${i}</button>`).join('')}</div>
      <textarea id="comment" placeholder="Anything you'd like to add? (optional)" rows="3"></textarea>
      <div><button class="submit" onclick="submitResponse()">Submit</button></div>
      <div id="thanks" style="display:none;margin-top:14px;color:#16a34a;font-weight:600">Thank you for your feedback! 🙏</div>
    </div>
    <script>
      let rating = null;
      function pick(v){ rating=v; document.querySelectorAll('#scale button').forEach(b=>b.classList.toggle('sel', +b.dataset.v===v)); }
      function submitResponse(){
        if (rating===null) return alert('Please select a rating from 0-10');
        fetch('/api/survey/${req.params.id}/respond', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ clientName: '${clientName.replace(/'/g,"")}', rating, comment: document.getElementById('comment').value })
        }).then(()=>{ document.querySelector('.card').innerHTML=''; document.getElementById('thanks').style.display='block'; document.querySelector('.card').appendChild(document.getElementById('thanks')); });
      }
    </script>
    </body></html>`);
});
app.post('/api/survey/:id/respond', (req, res) => {
  const s = DB.surveys[req.params.id];
  if (!s) return res.status(404).json({ ok: false });
  const { clientName, rating, comment } = req.body || {};
  DB.surveyResponses[req.params.id] = DB.surveyResponses[req.params.id] || [];
  DB.surveyResponses[req.params.id].push({ id: newId(), clientName: (clientName||'').slice(0,100), rating: parseInt(rating), comment: (comment||'').slice(0,1000), at: new Date().toISOString() });
  saveDB();
  res.json({ ok: true });
});
// Tenant's own BMS polls this (with its license key) to pull responses
// back into local storage — never the other way around, so the tenant
// always keeps their own copy of the data.
app.get('/api/survey/:id/responses', (req, res) => {
  const licenseKey = req.get('x-license-key') || 'UNKNOWN';
  const s = DB.surveys[req.params.id];
  if (!s || s.licenseKey !== licenseKey) return res.status(403).json({ ok: false, error: 'Not your survey.' });
  res.json({ ok: true, responses: DB.surveyResponses[req.params.id] || [] });
});

// =====================================================================
// SMS SENDING — mNotify (Ghana) or Hubtel SMS, same "bring your own
// credentials" model as email: nothing is stored server-side, keys
// travel with each request from the tenant's own Settings.
// =====================================================================
app.post('/api/sms/send', async (req, res) => {
  const { provider, apiKey, senderId, clientId, clientSecret, to, message } = req.body || {};
  if (!provider || provider === 'none') return res.status(400).json({ ok: false, error: 'No SMS provider configured.' });
  if (!to || !message) return res.status(400).json({ ok: false, error: 'to and message are required.' });
  try {
    if (provider === 'mnotify') {
      const url = `https://api.mnotify.com/api/sms/quick?key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: [to], sender: senderId || 'BMS', message, is_schedule: false }) });
      const data = await r.json().catch(()=>({}));
      if (!r.ok) return res.status(502).json({ ok: false, error: data.message || 'mNotify send failed.' });
      return res.json({ ok: true, provider: 'mnotify', response: data });
    }
    if (provider === 'hubtel') {
      const url = `https://smsc.hubtel.com/v1/messages/send?clientid=${encodeURIComponent(clientId)}&clientsecret=${encodeURIComponent(clientSecret)}&from=${encodeURIComponent(senderId||'BMS')}&to=${encodeURIComponent(to)}&content=${encodeURIComponent(message)}`;
      const r = await fetch(url);
      const data = await r.json().catch(()=>({}));
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Hubtel SMS send failed.' });
      return res.json({ ok: true, provider: 'hubtel', response: data });
    }
    return res.status(400).json({ ok: false, error: 'Unknown SMS provider.' });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
});

// =====================================================================
// PUBLIC REST API — read-only, per-license-key access to a tenant's
// OWN business-data snapshot, for Zapier/Make/custom integrations.
// Requires the tenant to have opted in from Settings → Public API
// (which is what pushes a snapshot here in the first place — nothing
// is exposed unless the tenant explicitly publishes it).
// =====================================================================
app.post('/api/public/sync', (req, res) => {
  const licenseKey = req.get('x-license-key') || 'UNKNOWN';
  const apiKey = req.get('x-api-key');
  const snapshot = req.body || {};
  DB.publicApiData = DB.publicApiData || {};
  const existing = DB.publicApiData[licenseKey];
  // First sync establishes the API key for this license; subsequent
  // syncs must present the same key, so nobody else can push data
  // under someone else's license.
  if (existing && existing.apiKey && existing.apiKey !== apiKey) {
    return res.status(403).json({ ok: false, error: 'Invalid API key for this license.' });
  }
  DB.publicApiData[licenseKey] = { apiKey: apiKey || existing?.apiKey, data: snapshot, syncedAt: new Date().toISOString() };
  saveDB();
  res.json({ ok: true, syncedAt: DB.publicApiData[licenseKey].syncedAt });
});
app.get('/api/public/v1/:resource', (req, res) => {
  const apiKey = req.get('x-api-key');
  if (!apiKey) return res.status(401).json({ ok: false, error: 'x-api-key header required.' });
  DB.publicApiData = DB.publicApiData || {};
  const entry = Object.values(DB.publicApiData).find(e => e.apiKey === apiKey);
  if (!entry) return res.status(401).json({ ok: false, error: 'Invalid API key.' });
  const resource = req.params.resource;
  const data = entry.data?.[resource];
  if (data === undefined) return res.status(404).json({ ok: false, error: `Unknown or unpublished resource: ${resource}. Available: ${Object.keys(entry.data||{}).join(', ')}` });
  res.json({ ok: true, resource, syncedAt: entry.syncedAt, data });
});

// =====================================================================
// REAL-TIME COLLABORATION — presence, live "who's viewing what",
// soft record-locking, team chat, and per-record comments.
// Everything here is scoped to a Socket.IO "room" per license key, so
// staff only ever see presence/chat/comments from their OWN business
// — never across tenants. Chat and comments are also persisted to DB
// (same store as everything else) and exposed via plain REST GET
// endpoints below, so a client that's offline or hasn't loaded
// Socket.IO yet still gets the latest data on reconnect — consistent
// with the rest of BMS being offline-first.
// =====================================================================
const presenceByRoom = {}; // { [licenseKey]: { [socketId]: {name, email, page, since} } }

function attachCollaboration(httpServer) {
  const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    let room = null, identity = null;

    socket.on('collab:join', (payload) => {
      const licenseKey = (payload && payload.licenseKey) || null;
      const deviceId = (payload && payload.deviceId) || null;
      if (!licenseKey || !deviceId) {
        socket.emit('collab:joinError', { error: 'Missing license key or device ID.' });
        return;
      }
      // AUTHENTICATION: a bare license key is not a secret — it can
      // appear in onboarding emails, screenshots, etc. — so it alone
      // must never be enough to join a tenant's live chat/comments/
      // presence. Require the license to be genuinely active AND the
      // connecting device to already be a checked-in activation on
      // that license (the same activations list /api/license/:key/
      // checkin maintains), so joining a room proves "this is a
      // device the license owner actually activated," not just
      // "this client typed a key it found somewhere."
      const lic = DB.licenses[licenseKey];
      const status = licenseStatusOf(lic);
      if (status !== 'active') {
        socket.emit('collab:joinError', { error: 'License is not active — cannot join team chat.' });
        return;
      }
      const knownDevice = (lic.activations || []).some(a => a.deviceId === deviceId);
      if (!knownDevice) {
        socket.emit('collab:joinError', { error: 'This device is not an activated seat on this license — cannot join team chat.' });
        return;
      }
      room = licenseKey;
      identity = { name: (payload.name || 'Staff').slice(0, 60), email: (payload.email || '').slice(0, 100), page: payload.page || null, since: Date.now() };
      socket.join(room);
      presenceByRoom[room] = presenceByRoom[room] || {};
      presenceByRoom[room][socket.id] = identity;
      socket.emit('collab:presence', Object.values(presenceByRoom[room]));
      socket.to(room).emit('collab:presence', Object.values(presenceByRoom[room]));
    });

    socket.on('collab:page', (payload) => {
      if (!room || !presenceByRoom[room]?.[socket.id]) return;
      presenceByRoom[room][socket.id].page = payload?.page || null;
      presenceByRoom[room][socket.id].recordId = payload?.recordId || null;
      io.to(room).emit('collab:presence', Object.values(presenceByRoom[room]));
    });

    // Soft edit-lock: just tells other viewers "someone's already
    // editing this" — never blocks the action. Matches the offline-
    // first design: a hard lock would break single-device offline use.
    socket.on('collab:editing', (payload) => {
      if (!room) return;
      socket.to(room).emit('collab:editing', { ...payload, by: identity?.name || 'Someone', socketId: socket.id });
    });
    socket.on('collab:doneEditing', (payload) => {
      if (!room) return;
      socket.to(room).emit('collab:doneEditing', { ...payload, socketId: socket.id });
    });

    socket.on('collab:chatSend', (payload) => {
      if (!room || !payload?.text) return;
      const msg = { id: newId(), room, author: identity?.name || 'Staff', authorEmail: identity?.email || '', text: String(payload.text).slice(0, 2000), at: new Date().toISOString() };
      DB.teamChat[room] = DB.teamChat[room] || [];
      DB.teamChat[room].push(msg);
      DB.teamChat[room] = DB.teamChat[room].slice(-500); // cap history per tenant
      saveDB();
      io.to(room).emit('collab:chatMessage', msg);
    });

    socket.on('collab:commentAdd', (payload) => {
      if (!room || !payload?.recordType || !payload?.recordId || !payload?.text) return;
      const key = `${payload.recordType}:${payload.recordId}`;
      const comment = { id: newId(), author: identity?.name || 'Staff', authorEmail: identity?.email || '', text: String(payload.text).slice(0, 2000), at: new Date().toISOString() };
      DB.recordComments[room] = DB.recordComments[room] || {};
      DB.recordComments[room][key] = DB.recordComments[room][key] || [];
      DB.recordComments[room][key].push(comment);
      saveDB();
      io.to(room).emit('collab:commentAdded', { recordType: payload.recordType, recordId: payload.recordId, comment });
    });

    socket.on('disconnect', () => {
      if (room && presenceByRoom[room]) {
        delete presenceByRoom[room][socket.id];
        io.to(room).emit('collab:presence', Object.values(presenceByRoom[room]));
        socket.to(room).emit('collab:editing', { cleared: true, socketId: socket.id });
      }
    });
  });

  return io;
}

// REST fallbacks (offline/reconnect catch-up — no socket required).
// Same authentication requirement as the socket join: the license
// must be active AND the requesting device must already be a known
// activation on it. Sent as headers (x-license-key / x-device-id)
// since these are simple GETs, not the POST-with-body pattern used
// elsewhere.
function requireActivatedDevice(req, res) {
  const licenseKey = req.params.licenseKey || req.get('x-license-key');
  const deviceId = req.get('x-device-id');
  if (!licenseKey || !deviceId) { res.status(401).json({ ok: false, error: 'Missing license key or device ID.' }); return null; }
  const lic = DB.licenses[licenseKey];
  const status = licenseStatusOf(lic);
  if (status !== 'active') { res.status(403).json({ ok: false, error: 'License is not active.' }); return null; }
  const knownDevice = (lic.activations || []).some(a => a.deviceId === deviceId);
  if (!knownDevice) { res.status(403).json({ ok: false, error: 'This device is not an activated seat on this license.' }); return null; }
  return licenseKey;
}
app.get('/api/collab/:licenseKey/chat', (req, res) => {
  const licenseKey = requireActivatedDevice(req, res);
  if (!licenseKey) return;
  const messages = (DB.teamChat[licenseKey] || []).slice(-200);
  res.json({ ok: true, messages });
});
app.get('/api/collab/:licenseKey/comments/:recordType/:recordId', (req, res) => {
  const licenseKey = requireActivatedDevice(req, res);
  if (!licenseKey) return;
  const key = `${req.params.recordType}:${req.params.recordId}`;
  const comments = DB.recordComments[licenseKey]?.[key] || [];
  res.json({ ok: true, comments });
});

app.use((req, res) => res.status(404).send(notFoundPage()));

// ---------------------------------------------------------------
// BOOT — connect to MongoDB (if configured) and load existing data
// BEFORE accepting any requests, so the very first request after a
// restart already sees every previously-published card.
// ---------------------------------------------------------------
async function boot() {
  await initMongo();
  DB = await loadDB();
  const httpServer = http.createServer(app);
  attachCollaboration(httpServer); // real-time presence, comments, team chat — see below
  httpServer.listen(PORT, () => {
    console.log(`\n🪪 ${BRAND.product} — Card Profile Service`);
    console.log(`   by ${BRAND.company} — running on port ${PORT}`);
    console.log(`   Storage: ${mongoCollection ? 'MongoDB (persistent ✅)' : 'local file only (NOT persistent on Render free tier ⚠️)'}`);
    console.log(`   Cards loaded: ${Object.keys(DB.cards).length}`);
    console.log(`   Realtime: Socket.IO attached (presence, chat, comments)`);
    console.log(`   Health check: /healthz\n`);
  });
}
boot();
