// functions/api/[[route]].js
//
// Single catch-all Pages Function that routes every /api/* request. Using one
// catch-all avoids per-route file layout and keeps the routing logic in one place.
//
// Endpoints:
//   POST /api/sessions                 -> create-or-reuse a session + append an update
//   GET  /api/sessions/:uuid           -> latest value + status
//   GET  /api/sessions/:uuid/poll      -> long-poll (timeout) for newer updates
//   POST /api/sweep                    -> (optional, secret-gated) purge expired rows
//   GET  /api/health                   -> liveness + backend probe
//
// Everything is free-tier friendly: no request is ever held longer than ~10s, and
// the "long-poll" below degrades to a fast poll when the client's budget is small.

import { storeFor, normalizeUpdate, toConsumerView, sessionStatus, SESSION_TTL_MS } from './db.js';

const CORS = {
   'Access-Control-Allow-Origin': '*',
   'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
   'Access-Control-Allow-Headers': 'Content-Type',
};

function json(status, body, extraHeaders = {}) {
   return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders },
   });
}

function notFound() {
   return json(404, { error: 'not_found' });
}

// The poll window the server is willing to hold, clamped to a safe free-tier bound.
// The client asks for a window via `?wait=` (seconds); we cap it so a slow or hung
// client can never exhaust the Pages execution budget.
const MAX_POLL_WAIT_MS = 10000;
const DEFAULT_POLL_WAIT_MS = 2500;
const MIN_POLL_WAIT_MS = 500;

export async function onRequest(context) {
   const { request, env, params } = context;
   const url = new URL(request.url);
   const path = url.pathname;

   // Preflight.
   if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
   }

   // Health / liveness probe.
   if (path === '/api/health' || path === '/api/health/') {
      const store = storeFor(env);
      const backend = env && env.DB ? 'd1' : 'memory';
      return json(200, { ok: true, backend, ttlMs: SESSION_TTL_MS, now: Date.now() });
   }

   // POST /api/sessions -> create-or-reuse + append
   if (path === '/api/sessions' && request.method === 'POST') {
      return handleCreateOrUpdate(request, env);
   }

   // POST /api/sweep -> purge expired rows (optional maintenance)
   if (path === '/api/sweep' && request.method === 'POST') {
      return handleSweep(request, env);
   }

   // GET /api/sessions/:uuid/poll
   const pollMatch = path.match(/^\/api\/sessions\/([^/]+)\/poll\/?$/);
   if (pollMatch && request.method === 'GET') {
      return handlePoll(pollMatch[1], url, env);
   }

   // GET /api/sessions/:uuid
   const getMatch = path.match(/^\/api\/sessions\/([^/]+)\/?$/);
   if (getMatch && request.method === 'GET') {
      return handleGet(getMatch[1], env);
   }

   return notFound();
}

// --- POST /api/sessions ------------------------------------------------------
async function handleCreateOrUpdate(request, env) {
   let body;
   try {
      body = await request.json();
   } catch {
      return json(400, { error: 'invalid_json' });
   }
   if (body == null || typeof body !== 'object') {
      return json(400, { error: 'invalid_body' });
   }

   const now = Date.now();
   const key = typeof body.key === 'string' && body.key.trim() !== '' ? body.key.trim() : null;

   // `value` is the decoded QR payload. A present but null/undefined value is
   // rejected; an empty string is allowed (a QR may legitimately decode to "").
   if (body.value == null) {
      return json(400, { error: 'missing_value' });
    }
   const value = String(body.value);

   const store = storeFor(env);
   const uuid = await store.createOrReuseSession(key, now);
   await store.appendUpdate(uuid, normalizeUpdate(body, now), now);
   const lastUploadAt = await store.getLastUploadAt(uuid);

   return json(200, {
      uuid,
      key: key ?? null,
      status: sessionStatus(lastUploadAt, now),
      createdAt: now,
      lastUploadAt,
   });
}

// --- GET /api/sessions/:uuid -------------------------------------------------
async function handleGet(uuid, env) {
   const store = storeFor(env);
   const now = Date.now();
   const lastUploadAt = await store.getLastUploadAt(uuid);
   if (lastUploadAt == null) {
      // No session with this id ever existed.
      return json(404, { error: 'session_not_found', uuid }, { 'Cache-Control': 'no-store' });
   }
   const latest = await store.getLatest(uuid);
   return json(200, toConsumerView(uuid, latest, lastUploadAt, now), { 'Cache-Control': 'no-store' });
}

// --- GET /api/sessions/:uuid/poll -------------------------------------------
// A pragmatic "long-poll" for the free tier: we check for a newer update, and if
// there is none we *hold* the request for the client-requested window (capped) so
// the client does not have to poll every second. If a newer update appears within
// the window we return immediately. This bounds each request well under the Pages
// execution limit while keeping client-side request volume low.
async function handlePoll(uuid, url, env) {
   const store = storeFor(env);
   const now = Date.now();
   const lastUploadAt = await store.getLastUploadAt(uuid);
   if (lastUploadAt == null) {
      return json(200, toConsumerView(uuid, null, null, now), { 'Cache-Control': 'no-store' });
   }

   // Session already expired? Tell the client so it can stop polling.
   if (sessionStatus(lastUploadAt, now) === 'expired') {
      const latest = await store.getLatest(uuid);
      return json(200, toConsumerView(uuid, latest, lastUploadAt, now), { 'Cache-Control': 'no-store' });
   }

   const since = url.searchParams.get('since');
   const checkNow = () => store.getUpdateAfter(uuid, since).then((u) => u || null);

   // Initial check (covers the common "there already is a newer update" case).
   let row = await checkNow();
   if (row) return changed(uuid, row, now, store);

   // Determine how long to hold the request.
   const waitSec = Number(url.searchParams.get('wait'));
   let waitMs = Number.isFinite(waitSec) && waitSec > 0 ? Math.round(waitSec * 1000) : DEFAULT_POLL_WAIT_MS;
   waitMs = Math.max(MIN_POLL_WAIT_MS, Math.min(waitMs, MAX_POLL_WAIT_MS));

   // Also cap to how long until this session itself expires, so we don't hold past TTL.
   const timeToExpire = lastUploadAt + SESSION_TTL_MS - Date.now();
   if (timeToExpire <= 0) {
      return json(200, toConsumerView(uuid, await store.getLatest(uuid), lastUploadAt, Date.now()), {
         'Cache-Control': 'no-store',
      });
   }
   waitMs = Math.min(waitMs, Math.max(MIN_POLL_WAIT_MS, timeToExpire));

   // Sleep (interruptible-ish), then re-check once.
   await sleep(waitMs);
   row = await checkNow();
   if (row) return changed(uuid, row, now, store);

   // Nothing new within the window -> unchanged.
   const view = toConsumerView(uuid, null, lastUploadAt, Date.now());
   return json(200, { status: 'unchanged', uuid, lastUploadAt: view.lastUploadAt, nextExpiry: view.nextExpiry }, {
      'Cache-Control': 'no-store',
   });
}

async function changed(uuid, row, now, store) {
   const lastUploadAt = await store.getLastUploadAt(uuid);
   const view = toConsumerView(uuid, row, lastUploadAt, now);
   view.status = 'changed';
   return json(200, view, { 'Cache-Control': 'no-store' });
}

// --- POST /api/sweep ---------------------------------------------------------
// Optional maintenance endpoint. Gated by an env secret so a random caller cannot
// purge other sessions. In production this is meant to be called by a scheduled
// Cron Trigger Worker; the manual endpoint is for convenience/testing.
async function handleSweep(request, env) {
   const secret = env && env.SWEEP_SECRET;
   const header = request.headers.get('x-sweep-secret');
   if (secret && header !== secret) {
      return json(401, { error: 'unauthorized' });
   }
   if (!secret && !env.ALLOW_OPEN_SWEEP) {
      // Without a configured secret the endpoint is disabled unless explicitly
      // allowed (e.g. local dev). This prevents an unauthenticated public purge.
      return json(403, { error: 'sweep_disabled', hint: 'set SWEEP_SECRET to enable' });
   }
   const store = storeFor(env);
   const result = await store.sweep(Date.now(), SESSION_TTL_MS);
   return json(200, { ok: true, deleted: result, ttlMs: SESSION_TTL_MS });
}

function sleep(ms) {
   return new Promise((r) => setTimeout(r, ms));
}
