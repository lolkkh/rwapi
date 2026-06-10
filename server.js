/**
 * ══════════════════════════════════════════════════════════════
 *   ROZGAR LEARNING PORTAL — Node.js API Server
 *   PHP rozgar-api.php ka 1:1 Node.js port
 *   Render.com pe deploy karne ke liye ready
 * ══════════════════════════════════════════════════════════════
 *
 *  Endpoints:
 *    GET /api/ping
 *    GET /api/batches
 *    GET /api/subjects?bid=X
 *    GET /api/topics?bid=X&sid=Y
 *    GET /api/content?bid=X&sid=Y&tid=Z
 *    GET /api/video?vid=V&bid=X&q=720p
 *    GET /api/pdf?l=ENCODED_LINK
 *    POST /api/clearcache
 */

'use strict';

const express    = require('express');
const crypto     = require('crypto');
const fetch      = require('node-fetch');
const rateLimit  = require('express-rate-limit');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

// ────────────────────────────────────────────────────────────────
// CONFIG  (PHP config.php ka equivalent)
// ────────────────────────────────────────────────────────────────
const CONFIG = {
  API_BASE:     process.env.API_BASE     || 'https://rozgarapinew.teachx.in',
  MASTER_TOKEN: process.env.MASTER_TOKEN || '
eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjQzMDAyNTUiLCJ0aW1lc3RhbXAiOjE3NzcwMTkwMTMsIml2X3ZlciI6MTksInNlc3Npb24iOiJleUowZVhBaU9pSktWMVFpTENKaGJHY2lPaUpJVXpJMU5pSjkuZXlKcFpDSTZJalF6TURBeU5UVWlMQ0psYldGcGJDSTZJbk5uTkRZek5UYzRRR2R0WVdsc0xtTnZiU0lzSW01aGJXVWlPaUpUYUdsMllXMGdSM1Z3ZEdFaUxDSjBaVzVoYm5SVWVYQmxJam9pZFhObGNpSXNJblJsYm1GdWRFNWhiV1VpT2lKeWIzcG5ZWEpmWkdJaUxDSjBaVzVoYm5SSlpDSTZJaUlzSW1ScGMzQnZjMkZpYkdVaU9tWmhiSE5sZlEuMkhiZE81d1hLNE5rZkt6RUVrczZBZHRRakxPalc0MXBubW5TeF9lZEc2NCJ9.8j1-FFb1n2Bqp4ZG61VwtMnkDDLQZUg3Hus4tlSNOAo',
  MASTER_USERID: process.env.MASTER_USERID || '4300255',
  AES_KEY:      process.env.AES_KEY       || '638udh3829162018',
  AES_IV:       process.env.AES_IV        || 'fedcba9876543210',
  PLAYER_BASE:  'https://mute-butterfly-7f12.techdesh5.workers.dev/player?url=',
  PDF_BASE:     'https://mute-butterfly-7f12.techdesh5.workers.dev/pdf-viewer?url=',
  CACHE_TTL:    600,       // 10 minutes
  STALE_TTL:    86400,     // 24 hours stale fallback
  UPSTREAM_TIMEOUT: 20000, // 20s
};

// In-memory cache (Map) — Render free tier has no persistent disk write
// For production, switch to Redis or a persistent volume
const memCache = new Map(); // key → { data, ts }

// Temp dir for cache files (Render free tier has writable /tmp)
const CACHE_DIR = path.join(os.tmpdir(), 'rozgar_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ────────────────────────────────────────────────────────────────
// AES-128-CBC Decryption  (PHP decrypt_appx() ka port)
// ────────────────────────────────────────────────────────────────
function decryptAppx(enc) {
  if (!enc) return '';
  try {
    const parts   = enc.split(':');
    const encData = Buffer.from(parts[0], 'base64');
    const key     = Buffer.from(CONFIG.AES_KEY, 'utf8');  // 16 bytes
    const iv      = Buffer.from(CONFIG.AES_IV,  'utf8');  // 16 bytes
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    let decrypted  = Buffer.concat([decipher.update(encData), decipher.final()]);
    // Remove null padding
    let end = decrypted.length;
    while (end > 0 && decrypted[end - 1] === 0) end--;
    return decrypted.slice(0, end).toString('utf8');
  } catch (e) {
    return '';
  }
}

// ────────────────────────────────────────────────────────────────
// UPSTREAM FETCH  (PHP upstream_fetch() ka port)
// ────────────────────────────────────────────────────────────────
async function upstreamFetch(endpoint, token, userid) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = CONFIG.API_BASE + endpoint + sep + 'userid=' + encodeURIComponent(userid);

  let res, body;
  try {
    res = await fetch(url, {
      method: 'GET',
      timeout: CONFIG.UPSTREAM_TIMEOUT,
      headers: {
        'Client-Service': 'Appx',
        'source':         'website',
        'Auth-Key':       'appxapi',
        'Authorization':  token,
        'User-ID':        userid,
        'User-Agent':     'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36',
      },
    });
    body = await res.text();
  } catch (e) {
    return { _failed: true, data: [], error: 'Network error: ' + e.message };
  }

  // Mark failed on bad upstream codes
  if ([429, 502, 503].includes(res.status)) {
    return { _failed: true, data: [], error: 'Upstream returned ' + res.status };
  }

  // Parse JSON
  let data = safeParse(body);
  if (!data) {
    // Try extract embedded JSON (some responses have junk prefix)
    const m = body.match(/\{[\s\S]*\}/);
    if (m) data = safeParse(m[0]);
  }
  if (!data) {
    return { _failed: true, data: [], error: 'JSON parse failed (http ' + res.status + ')' };
  }

  data._failed = false;
  return data;
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ────────────────────────────────────────────────────────────────
// CACHE LAYER  (PHP cached_api() ka port — uses /tmp + in-memory)
// ────────────────────────────────────────────────────────────────
function cacheKey(key) {
  return path.join(CACHE_DIR, 'api_' + crypto.createHash('md5').update(key).digest('hex') + '.json');
}

function readCache(key) {
  // 1. Check in-memory first
  if (memCache.has(key)) return memCache.get(key);
  // 2. Check disk
  const file = cacheKey(key);
  try {
    if (fs.existsSync(file)) {
      const raw  = fs.readFileSync(file, 'utf8');
      const data = safeParse(raw);
      if (data) {
        memCache.set(key, data); // warm in-memory
        return data;
      }
    }
  } catch {}
  return null;
}

function writeCache(key, data) {
  try {
    memCache.set(key, data);
    fs.writeFileSync(cacheKey(key), JSON.stringify(data), 'utf8');
  } catch {}
}

function cacheAge(key) {
  const file = cacheKey(key);
  try {
    const stat = fs.statSync(file);
    return (Date.now() - stat.mtimeMs) / 1000; // seconds
  } catch {}
  return Infinity;
}

function clearCache() {
  memCache.clear();
  let deleted = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.endsWith('.json')) {
        fs.unlinkSync(path.join(CACHE_DIR, f));
        deleted++;
      }
    }
  } catch {}
  return deleted;
}

async function cachedApi(endpoint, cacheKeyStr, ttl = 600) {
  const age = cacheAge(cacheKeyStr);

  // Serve fresh cache if within TTL
  if (age < ttl) {
    const cached = readCache(cacheKeyStr);
    if (cached && cached.data && cached.data.length) {
      return { ...cached, _cache_hit: true };
    }
  }

  // Fetch from upstream
  const result = await upstreamFetch(endpoint, CONFIG.MASTER_TOKEN, CONFIG.MASTER_USERID);

  // On failure, serve stale cache
  if (result._failed) {
    const stale = readCache(cacheKeyStr);
    if (stale && stale.data && stale.data.length) {
      return { ...stale, _cache_hit: 'stale' };
    }
    return { ok: false, data: [], error: result.error, _failed: true };
  }

  // Save valid data
  if (result.data && result.data.length) {
    writeCache(cacheKeyStr, result);
  }

  return { ...result, _cache_hit: false };
}

// ────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

// Security headers (PHP send_security_headers() ka port)
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options':  'nosniff',
    'X-Frame-Options':         'DENY',
    'X-XSS-Protection':        '1; mode=block',
    'Referrer-Policy':         'no-referrer',
    'Cache-Control':           'no-store, no-cache, must-revalidate, private',
    'Content-Type':            'application/json; charset=utf-8',
    'X-API-Version':           '2.0',
  });
  next();
});

// CORS — frontend domains allow karo
app.use((req, res, next) => {
  const allowed = [
    'https://rozgar-portal.onrender.com',
    'http://localhost',
    'http://127.0.0.1',
  ];
  const origin = req.headers.origin;
  if (!origin || allowed.some(a => origin.startsWith(a))) {
    res.set('Access-Control-Allow-Origin', origin || '*');
  }
  res.set('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Rate limit (200 req/min per IP — PHP rl2_ equivalent)
const limiter = rateLimit({
  windowMs:        60 * 1000,
  max:             200,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many requests. Please slow down.', code: 429 }),
});
app.use('/api/', limiter);

app.use(express.json());

// ────────────────────────────────────────────────────────────────
// HELPER: respond()
// ────────────────────────────────────────────────────────────────
function respond(res, data) {
  if (data._cache_hit !== undefined) {
    res.set('X-Cache', data._cache_hit === true ? 'HIT' : data._cache_hit === 'stale' ? 'STALE' : 'MISS');
    const clean = { ...data };
    delete clean._cache_hit;
    delete clean._failed;
    data = clean;
  }
  if (!data.data && !data.status) {
    return res.json({ ok: false, error: 'No data returned from upstream', data: [] });
  }
  data.ok = true;
  res.json(data);
}

// ────────────────────────────────────────────────────────────────
// ROUTES
// ────────────────────────────────────────────────────────────────

// ── /api/ping ────────────────────────────────────────────────────
app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, ts: Math.floor(Date.now() / 1000), v: '2.0', runtime: 'nodejs' });
});

// ── /api/batches ─────────────────────────────────────────────────
app.get('/api/batches', async (_req, res) => {
  const data = await cachedApi(
    '/get/mycoursev2?',
    'batches_' + CONFIG.MASTER_USERID,
    CONFIG.CACHE_TTL
  );
  respond(res, data);
});

// ── /api/subjects?bid=X ──────────────────────────────────────────
app.get('/api/subjects', async (req, res) => {
  const bid = parseInt(req.query.bid) || 0;
  if (!bid) return res.status(400).json({ ok: false, error: 'bid required', code: 400 });

  const data = await cachedApi(
    `/get/allsubjectfrmlivecourseclass?courseid=${bid}&start=-1`,
    'subj_' + bid,
    CONFIG.CACHE_TTL
  );
  respond(res, data);
});

// ── /api/topics?bid=X&sid=Y ──────────────────────────────────────
app.get('/api/topics', async (req, res) => {
  const bid = parseInt(req.query.bid) || 0;
  const sid = parseInt(req.query.sid) || 0;
  if (!bid || !sid) return res.status(400).json({ ok: false, error: 'bid and sid required', code: 400 });

  const data = await cachedApi(
    `/get/alltopicfrmlivecourseclass?courseid=${bid}&subjectid=${sid}&start=-1`,
    `topics_${bid}_${sid}`,
    CONFIG.CACHE_TTL
  );
  respond(res, data);
});

// ── /api/content?bid=X&sid=Y&tid=Z ───────────────────────────────
app.get('/api/content', async (req, res) => {
  const bid = parseInt(req.query.bid) || 0;
  const sid = parseInt(req.query.sid) || 0;
  const tid = parseInt(req.query.tid) || 0;
  if (!bid || !sid || !tid) return res.status(400).json({ ok: false, error: 'bid, sid, tid required', code: 400 });

  const data = await cachedApi(
    `/get/livecourseclassbycoursesubtopconceptapiv3?courseid=${bid}&subjectid=${sid}&topicid=${tid}&conceptid=&start=-1`,
    `content_${bid}_${sid}_${tid}`,
    300 // 5 min for content
  );

  // Classify items + strip sensitive fields (same as PHP content case)
  if (data.data && Array.isArray(data.data)) {
    data.data = data.data.map(item => {
      const hasPdf   = !!(item.pdf_link || item.pdf_link2);
      const hasVideo = !!item.id; // id = video lecture id

      if (hasPdf && hasVideo) {
        const raw = String(item.pdf_link || item.pdf_link2 || '').trim();
        item._type    = 'both';
        item._pdf_ref = encodeURIComponent(raw);
      } else if (hasPdf) {
        const raw = String(item.pdf_link || item.pdf_link2 || '').trim();
        item._type    = 'pdf';
        item._pdf_ref = encodeURIComponent(raw);
      } else {
        item._type = 'video';
      }

      // Remove sensitive/encrypted fields — AES keys never go to browser
      delete item.download_link;
      delete item.encrypted_links;
      delete item.pdf_link;
      delete item.pdf_link2;
      delete item.video_id;

      return item;
    });
  }

  respond(res, data);
});

// ── /api/video?vid=V&bid=X&q=720p ────────────────────────────────
app.get('/api/video', async (req, res) => {
  const vid = parseInt(req.query.vid) || 0;
  const bid = parseInt(req.query.bid) || 0;
  const q   = (req.query.q || 'auto').replace(/[^a-z0-9]/g, '');

  if (!vid || !bid) return res.status(400).json({ ok: false, error: 'vid and bid required', code: 400 });

  const endpoint = `/get/fetchVideoDetailsById?course_id=${bid}&video_id=${vid}&ytflag=0&folder_wise_course=0`;
  let result = await upstreamFetch(endpoint, CONFIG.MASTER_TOKEN, CONFIG.MASTER_USERID);

  // Try cache on failure
  if (result._failed || !result.data) {
    const cached = readCache(`vid_${vid}_${bid}`);
    if (cached) result = cached;
  }

  const d = result.data || null;
  if (!d) return res.status(404).json({ ok: false, error: 'Video not found or upstream error', code: 404 });

  // Cache successful fetch
  if (d) writeCache(`vid_${vid}_${bid}`, result);

  // ── YouTube
  if (d.video_id && !d.download_link) {
    const yt = d.video_id.length > 20 ? decryptAppx(d.video_id) : d.video_id;
    return res.json({ ok: true, type: 'youtube', url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(yt) });
  }

  // ── Direct download_link (AES encrypted) — raw URL, no external player
  if (d.download_link) {
    let u = decryptAppx(d.download_link);
    if (q !== 'auto') u = u.replace(/(1080p|720p|480p|360p|240p)/, q);
    return res.json({ ok: true, type: 'hls', url: u });
  }

  // ── encrypted_links array — raw URL, no external player
  const lnks = d.encrypted_links || [];
  for (const lnk of lnks) {
    if (lnk.path) {
      let u = decryptAppx(lnk.path);
      if (u) {
        if (q !== 'auto') u = u.replace(/(1080p|720p|480p|360p|240p)/, q);
        return res.json({ ok: true, type: 'hls', url: u });
      }
    }
  }

  res.status(404).json({ ok: false, error: 'No playable source found for this video', code: 404 });
});

// ── /api/pdf?l=ENCODED_LINK ──────────────────────────────────────
app.get('/api/pdf', (req, res) => {
  const enc = req.query.l || '';
  if (!enc) return res.status(400).json({ ok: false, error: 'l (link) required', code: 400 });

  const viewer = CONFIG.PDF_BASE;
  const raw    = decodeURIComponent(enc);

  // Already a plain URL
  if (raw.startsWith('http')) {
    return res.json({ ok: true, type: 'pdf', url: viewer + encodeURIComponent(raw) });
  }

  // AES encrypted
  const u = decryptAppx(raw);
  if (!u) return res.status(400).json({ ok: false, error: 'Could not decrypt PDF link', code: 400 });

  res.json({ ok: true, type: 'pdf', url: viewer + encodeURIComponent(u) });
});

// ── /api/clearcache (POST) ────────────────────────────────────────
app.post('/api/clearcache', (req, res) => {
  const deleted = clearCache();
  res.json({ ok: true, deleted, message: `${deleted} cache files cleared` });
});

// ────────────────────────────────────────────────────────────────
// 404 handler
// ────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Unknown endpoint: ' + req.path, code: 404 });
});

// ────────────────────────────────────────────────────────────────
// Start
// ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Rozgar API Server running on port ${PORT}`);
  console.log(`   API_BASE: ${CONFIG.API_BASE}`);
  console.log(`   Cache Dir: ${CACHE_DIR}`);
  console.log(`   Endpoints:`);
  console.log(`     GET /api/ping`);
  console.log(`     GET /api/batches`);
  console.log(`     GET /api/subjects?bid=X`);
  console.log(`     GET /api/topics?bid=X&sid=Y`);
  console.log(`     GET /api/content?bid=X&sid=Y&tid=Z`);
  console.log(`     GET /api/video?vid=V&bid=X&q=720p`);
  console.log(`     GET /api/pdf?l=ENCODED_LINK`);
  console.log(`    POST /api/clearcache`);
});

module.exports = app;
