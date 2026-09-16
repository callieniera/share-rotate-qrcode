// functions/api/[[route]].js
//
// Single catch-all Pages Function that routes every /api/* request. Using one
// catch-all avoids per-route file layout and keeps the routing logic in one place.
//
// Endpoints:
//   POST /api/sessions                 -> create-or-reuse a session + append an update
//   GET  /api/sessions/:uuid           -> latest value + status
//   GET  /api/sessions/:uuid/poll      -> immediate check for newer updates
//   POST /api/sweep                    -> (optional, secret-gated) purge expired rows
//   GET  /api/health                   -> liveness + backend probe
//
// Poll requests are intentionally short-lived; the client chooses when to request
// the next check based on QR validity and session state.

import { storeFor, normalizeUpdate, toConsumerView, sessionStatus, SESSION_TTL_MS } from "./db.js";

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

function json(status, body, extraHeaders = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extraHeaders },
	});
}

function notFound() {
	return json(404, { error: "not_found" });
}

export async function onRequest(context) {
	const { request, env, params } = context;
	const url = new URL(request.url);
	const path = url.pathname;

	// Preflight.
	if (request.method === "OPTIONS") {
		return new Response(null, { headers: CORS });
	}

	// Health / liveness probe.
	if (path === "/api/health" || path === "/api/health/") {
		const store = storeFor(env);
		const backend = env && env.DB ? "d1" : "memory";
		return json(200, { ok: true, backend, ttlMs: SESSION_TTL_MS, now: Date.now() });
	}

	// POST /api/sessions -> create-or-reuse + append
	if (path === "/api/sessions" && request.method === "POST") {
		return handleCreateOrUpdate(request, env);
	}

	// POST /api/sweep -> purge expired rows (optional maintenance)
	if (path === "/api/sweep" && request.method === "POST") {
		return handleSweep(request, env);
	}

	// GET /api/sessions/:uuid/poll
	const pollMatch = path.match(/^\/api\/sessions\/([^/]+)\/poll\/?$/);
	if (pollMatch && request.method === "GET") {
		return handlePoll(pollMatch[1], url, env);
	}

	// GET /api/sessions/:uuid
	const getMatch = path.match(/^\/api\/sessions\/([^/]+)\/?$/);
	if (getMatch && request.method === "GET") {
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
		return json(400, { error: "invalid_json" });
	}
	if (body == null || typeof body !== "object") {
		return json(400, { error: "invalid_body" });
	}

	const now = Date.now();
	const requestedUuid = typeof body.uuid === "string" && body.uuid.trim() !== "" ? body.uuid.trim() : null;

	// `value` is the decoded QR payload. A present but null/undefined value is
	// rejected; an empty string is allowed (a QR may legitimately decode to "").
	if (body.value == null) {
		return json(400, { error: "missing_value" });
	}
	const value = String(body.value);

	const store = storeFor(env);
	const uuid = await store.createOrReuseSession(requestedUuid, value, now);
	await store.appendUpdate(uuid, normalizeUpdate(body, now), now);
	const lastUploadAt = await store.getLastUploadAt(uuid);

	return json(200, {
		uuid,
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
		return json(404, { error: "session_not_found", uuid }, { "Cache-Control": "no-store" });
	}
	const latest = await store.getLatest(uuid);
	return json(200, toConsumerView(uuid, latest, lastUploadAt, now), { "Cache-Control": "no-store" });
}

// --- GET /api/sessions/:uuid/poll -------------------------------------------
// A normal poll: check once and return immediately. The client controls request
// cadence because QR validity varies by update.
async function handlePoll(uuid, url, env) {
	const store = storeFor(env);
	const now = Date.now();
	const lastUploadAt = await store.getLastUploadAt(uuid);
	if (lastUploadAt == null) {
		return json(200, toConsumerView(uuid, null, null, now), { "Cache-Control": "no-store" });
	}

	// Session already expired? Tell the client so it can stop polling.
	if (sessionStatus(lastUploadAt, now) === "expired") {
		const latest = await store.getLatest(uuid);
		return json(200, toConsumerView(uuid, latest, lastUploadAt, now), { "Cache-Control": "no-store" });
	}

	const since = url.searchParams.get("since");
	const row = await store.getUpdateAfter(uuid, since);
	if (row) return changed(uuid, row, now, store);

	// Nothing newer is available right now.
	const view = toConsumerView(uuid, null, lastUploadAt, Date.now());
	return json(
		200,
		{ status: "unchanged", uuid, lastUploadAt: view.lastUploadAt, nextExpiry: view.nextExpiry },
		{
			"Cache-Control": "no-store",
		}
	);
}

async function changed(uuid, row, now, store) {
	const lastUploadAt = await store.getLastUploadAt(uuid);
	const view = toConsumerView(uuid, row, lastUploadAt, now);
	view.status = "changed";
	return json(200, view, { "Cache-Control": "no-store" });
}

// --- POST /api/sweep ---------------------------------------------------------
// Optional maintenance endpoint. Gated by an env secret so a random caller cannot
// purge other sessions. In production this is meant to be called by a scheduled
// Cron Trigger Worker; the manual endpoint is for convenience/testing.
async function handleSweep(request, env) {
	const secret = env && env.SWEEP_SECRET;
	const header = request.headers.get("x-sweep-secret");
	if (secret && header !== secret) {
		return json(401, { error: "unauthorized" });
	}
	if (!secret && !env.ALLOW_OPEN_SWEEP) {
		// Without a configured secret the endpoint is disabled unless explicitly
		// allowed (e.g. local dev). This prevents an unauthenticated public purge.
		return json(403, { error: "sweep_disabled", hint: "set SWEEP_SECRET to enable" });
	}
	const store = storeFor(env);
	const result = await store.sweep(Date.now(), SESSION_TTL_MS);
	return json(200, { ok: true, deleted: result, ttlMs: SESSION_TTL_MS });
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
