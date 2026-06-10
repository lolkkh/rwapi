# Rozgar Learning Portal — Node.js API v2.0

PHP `rozgar-api.php` ka complete Node.js port — Render.com ke liye ready.

## Files

| File | Description |
|---|---|
| `server.js` | Main API server (Express.js) |
| `render.yaml` | Render deployment config |
| `package.json` | Dependencies |

## Endpoints

| Method | Endpoint | Params | Description |
|---|---|---|---|
| GET | `/api/ping` | — | Health check |
| GET | `/api/batches` | — | Enrolled courses |
| GET | `/api/subjects` | `?bid=X` | Subjects for a batch |
| GET | `/api/topics` | `?bid=X&sid=Y` | Topics for a subject |
| GET | `/api/content` | `?bid=X&sid=Y&tid=Z` | Content list (videos + PDFs) |
| GET | `/api/video` | `?vid=V&bid=X&q=720p` | Decrypted video URL |
| GET | `/api/pdf` | `?l=ENCODED_LINK` | Decrypted PDF viewer URL |
| POST | `/api/clearcache` | — | Clear all cached files |

## Render pe Deploy karna

1. Ye folder GitHub pe push karo
2. Render dashboard → **New Web Service**
3. GitHub repo connect karo
4. **Build Command:** `npm install`
5. **Start Command:** `node server.js`
6. **Environment:** Node
7. Deploy karo ✅

## Environment Variables (Optional)

Render dashboard → Environment tab mein set karo:

| Key | Default | Description |
|---|---|---|
| `PORT` | 3000 | Server port (Render auto-set karta hai) |
| `MASTER_TOKEN` | config mein hardcoded | JWT token override |
| `MASTER_USERID` | config mein hardcoded | User ID override |
| `AES_KEY` | config mein hardcoded | AES decryption key |
| `AES_IV` | config mein hardcoded | AES IV |

## Frontend mein use karna

```js
// PHP rozgar-api.php ki jagah Node API use karo
const BASE = 'https://your-app.onrender.com';

// Batches fetch
const r = await fetch(`${BASE}/api/batches`, {
  headers: { 'X-Requested-With': 'XMLHttpRequest' }
});
const data = await r.json();

// Video URL get karo
const v = await fetch(`${BASE}/api/video?vid=123&bid=456&q=720p`);
const vd = await v.json();
// vd.url → player URL
```

## Features

- ✅ AES-128-CBC decryption server-side (key browser tak nahi jaata)
- ✅ Aggressive caching (10 min fresh, 24h stale fallback)
- ✅ 429/502/503 upstream error handling
- ✅ Rate limiting (200 req/min per IP)
- ✅ Security headers
- ✅ CORS support
- ✅ `/tmp` cache (Render free tier compatible)
- ✅ In-memory + disk dual cache layer
