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
app.use(express.json({ limit: '6mb' }));

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
// TINY JSON FILE DATABASE
// (Fine for this workload — a few thousand cards. If you outgrow
// it, swap loadDB/saveDB for a real database call; every other
// route stays the same. See README-DEPLOY.md.)
// ---------------------------------------------------------------
function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return { cards: {}, packages: {} };
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return { cards: parsed.cards || {}, packages: parsed.packages || {} };
  } catch (e) {
    console.error('DB load error, starting with an empty store:', e.message);
    return { cards: {}, packages: {} };
  }
}
let DB = loadDB();
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2));
    } catch (e) {
      console.error('DB save error:', e.message);
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

app.get('/healthz', (req, res) => res.json({ ok: true, product: BRAND.product, company: BRAND.company, cards: Object.keys(DB.cards).length }));

// ---------------------------------------------------------------
// CARD SYNC  (called by the BMS desktop app whenever a card is saved)
// ---------------------------------------------------------------
app.post('/api/cards', (req, res) => {
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
  card.stats = card.stats || { views: 0, saves: 0, shares: 0 };
  card.stats.views += 1;
  saveDB();
  res.send(renderProfilePage(card, req));
});

app.get('/vcf/:id', (req, res) => {
  const card = DB.cards[req.params.id];
  if (!card) return res.status(404).send('Not found');
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
  DB.packages[licenseKey] = {
    enabled: !!enabled,
    price: price || null,
    notes: notes || '',
    approvedBy: approvedBy || 'Beat Digital Consult',
    approvedAt: new Date().toISOString()
  };
  saveDB();
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

app.listen(PORT, () => {
  console.log(`\n🪪 ${BRAND.product} — Card Profile Service`);
  console.log(`   by ${BRAND.company} — running on port ${PORT}`);
  console.log(`   Health check: /healthz\n`);
});
