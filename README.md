# share-rotate-qrcode

Share a **rotating QR code** across devices using a browser camera scanner, backed by
**Cloudflare Pages + D1** (free-tier first).

- A **scanner** points a device camera at a QR that rotates ~every 30s. The QR is decoded
   and the **expiry text printed beneath it is OCR'd — entirely in the browser**. The
   decoded payload is uploaded to a **shared session UUID**.
- A **viewer** (non-scanning user) opens a shareable link and **polls** for the latest
   value.
- The **same session UUID** is reused for the same QR/session — even from a different
   scanner — and a session **expires after 5 minutes** of no uploads.

> No camera frames ever leave the device. The server only ever receives the decoded
> text + parsed expiry + a session key.

---

## Requirements

- Node.js (≥ 18) and `npx`.
- A Cloudflare account. `npx wrangler login` once.

## Local development

```bash
# 1. install the CLI (or just use npx)
npm install

# 2. run locally — static assets + API on http://localhost:8787,
#    with a local SQLite D1 (no cloud needed to try it)
npm run dev
```

Open the scanner at **https** or **localhost** (the camera needs a secure context):

- Scanner: `http://localhost:8787/`
- Viewer:   `http://localhost:8787/c.html?uuid=<uuid>`

> Without a D1 binding the API automatically falls back to an **in-memory** store, so the
> whole flow is runnable with zero cloud setup. State is lost on restart.

The scanner requires a visible QR before it uploads. If no QR is decoded for 10 seconds,
it warns the operator; supported devices expose a camera zoom control.

## Deploy

```bash
# Create/reuse the D1 database, apply the schema, and deploy Pages.
# The database ID is saved locally in .d1-db-id and is ignored by git.
npm run deploy
```

The deploy command finds an existing `share-rotate-qrcode-db` database in the
authenticated Cloudflare account, creates it if needed, applies the remote schema,
and deploys Pages. Run `npx wrangler login` first.

After deploy you get a `https://<project>.pages.dev` URL. Open it as the scanner; the
`/c.html?uuid=<uuid>` link it produces is the shareable viewer.

### Optional: scheduled expiry sweep

Expiry is enforced lazily on every read, so a sweep is not required for correctness. To
purge rows proactively, add a Cloudflare **Cron Trigger** that calls `POST /api/sweep`
with `SWEEP_SECRET` (see `.dev.vars.example`). Without a secret the endpoint is disabled.

---

## API reference

All endpoints are under `/api`. Responses are JSON. `X-Content-Type-Options` etc. are
not set; CORS is open (`*`) for read/upload.

### `POST /api/sessions`
Create-or-reuse a session and append an update.

```json
{
  "key": "room-7",          // optional; omit to always create a new session
  "value": "OTC-1234-56",   // required; decoded QR text
  "rotationAt": 1893456000000, // optional epoch ms of this rotation
  "expiresAt": 1893456180000    // optional epoch ms parsed from OCR'd expiry text
}
```

→ `200 { uuid, key, status, createdAt, lastUploadAt }`

### `GET /api/sessions/:uuid`
Latest value + status. `status` is `active | expired | waiting`.
→ `200 { uuid, status, update, nextExpiry, lastUploadAt, createdAt, ttlMs, now }`
→ `404 { error: "session_not_found" }`

### `GET /api/sessions/:uuid/poll?since=<updateId>&wait=<sec>`
Short long-poll. Returns the next newer update, or `status: "unchanged"`. The server
holds the request up to `wait` seconds (capped < 10s) and to the session's remaining
TTL.
→ `200 { status: "changed"|"unchanged"|"expired"|"waiting", update?, nextExpiry, ... }`

### `POST /api/sweep`  *(optional, secret-gated)*
Purge sessions/updates older than `SESSION_TTL_MS`. Requires `SWEEP_SECRET`
(`x-sweep-secret` header) or `ALLOW_OPEN_SWEEP=true`.

### `GET /api/health`
Liveness + backend probe (`d1` or `memory`).

---

## File map

```
wrangler.jsonc                     Pages + D1 binding config
migrations/0001_init.sql           sessions + updates schema
functions/api/[[route]].js         single catch-all API dispatcher
functions/api/db.js                storage layer (D1 + in-memory), TTL, view helpers
public/index.html  public/scan.js  scanner (camera + jsQR + Tesseract OCR + upload)
public/c.html      public/consumer.js  viewer (poll + history)
public/common.js   shared browser helpers (copy, time formatting, API base)
public/app.css     styling
```

## Tuning

- **QR/OCR region** — the expiry is assumed directly beneath the QR. Adjust
   `stripBelowQr()` in `scan.js` (padding / strip height) for your QR layout.
- **Expiry format** — `parseExpiry()` in `scan.js` is intentionally tolerant
   (epoch ms/s, `HH:MM:SS`, `Date.parse`). Extend it for your specific format.
- **Frame rate / upload cadence** — `DECODE_INTERVAL_MS` (~2 fps) and the fixed 5-second
   fallback renewal cadence keep cost low.
- **Camera zoom / no-QR warning** — zoom is enabled when the active track exposes a zoom
   capability; otherwise scanning remains available and a no-QR warning appears after 10s.
- **TTL** — `SESSION_TTL_MS` in `functions/api/db.js` (default 5 min).

## Known limitations

- **OCR accuracy** on a moving, low-res camera strip is not perfect; failed reads keep
   the last good `expiresAt`. OCR is throttled and only runs on (re)detection.
- **Cross-device sharing** needs an explicit shared-key protocol; the scanner currently
   keeps its generated device key internal.
- **Long-poll** is a capped short poll, not a WebSocket — fine for low scale; move to a
   dedicated Worker or add a WebSocket for higher scale.
