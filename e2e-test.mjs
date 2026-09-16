// e2e-test.mjs — drive the real Pages Function handler in-process (no network).
// Run: node e2e-test.mjs
import { onRequest } from "./functions/api/[[route]].js";

let failures = 0;
function assert(c, m) {
	if (c) console.log("  ✓ " + m);
	else {
		failures++;
		console.error("  ✗ " + m);
	}
}

function ctx(path, { method = "GET", body, env } = {}) {
	const url = "http://localhost" + path;
	const req = new Request(url, {
		method,
		body: body != null ? JSON.stringify(body) : undefined,
		headers: body != null ? { "Content-Type": "application/json" } : undefined,
	});
	return { request: req, env: env || {}, params: {} };
}
async function call(c) {
	const res = await onRequest(c);
	let json = null;
	try {
		json = await res.json();
	} catch (_) {}
	return { status: res.status, json };
}

console.log("\n[POST /api/sessions] create");
{
	const r = await call(ctx("/api/sessions", { method: "POST", body: { value: "OTC-A", rotationAt: 1, expiresAt: 9e13 } }));
	assert(r.status === 200, "POST returns 200");
	assert(typeof r.json.uuid === "string" && r.json.uuid.length > 0, "returns a uuid");
	assert(r.json.status === "active", "status active");
	globalThis.__uuid = r.json.uuid;
}

console.log("\n[POST /api/sessions] uuid reuse updates current value");
{
	const r = await call(ctx("/api/sessions", { method: "POST", body: { uuid: globalThis.__uuid, value: "OTC-B", rotationAt: 2, expiresAt: 9e13 } }));
	assert(r.json.uuid === globalThis.__uuid, "active uuid is reused");
	assert(r.json.matchedUpdate === null, "first upload for a QR has no matched update");
	assert(!Object.prototype.hasOwnProperty.call(r.json, "key"), "response has no key field");
	const otherScanner = await call(ctx("/api/sessions", { method: "POST", body: { value: "OTC-B" } }));
	assert(otherScanner.json.uuid === globalThis.__uuid, "second scanner matches current QR value");
	assert(otherScanner.json.matchedUpdate && otherScanner.json.matchedUpdate.expiresAt === 9e13, "matching QR receives existing expiry");
	const oldQr = await call(ctx("/api/sessions", { method: "POST", body: { value: "OTC-A" } }));
	assert(oldQr.json.uuid !== globalThis.__uuid, "old QR value does not match rotated session");
	const fallback = await call(ctx("/api/sessions", { method: "POST", body: { value: "OTC-B", expiresAt: 9e13, expiryFallback: true } }));
	assert(fallback.json.matchedUpdate === null, "fallback expiry is not shared as valid");
}

console.log("\n[GET /api/sessions/:uuid] latest");
{
	const r = await call(ctx(`/api/sessions/${globalThis.__uuid}`));
	assert(r.status === 200, "GET returns 200");
	assert(r.json.update.value === "OTC-B", "latest value is OTC-B");
	globalThis.__lastId = r.json.update.id;
	assert(r.json.status === "active", "GET status active");
}

console.log("\n[GET poll] immediate unchanged then changed");
{
	const startedAt = Date.now();
	const unchanged = await call(ctx(`/api/sessions/${globalThis.__uuid}/poll?since=${globalThis.__lastId}&wait=0`));
	assert(unchanged.json.status === "unchanged", "poll since latest -> unchanged");
	assert(Date.now() - startedAt < 500, "unchanged poll returns immediately");
	// upload a new value
	await call(ctx("/api/sessions", { method: "POST", body: { uuid: globalThis.__uuid, value: "OTC-C" } }));
	const changed = await call(ctx(`/api/sessions/${globalThis.__uuid}/poll?since=${globalThis.__lastId}&wait=0`));
	assert(changed.json.status === "changed", "poll after new upload -> changed");
	assert(changed.json.update.value === "OTC-C", "changed update has new value");
}

console.log("\n[GET 404] unknown session");
{
	const r = await call(ctx("/api/sessions/does-not-exist"));
	assert(r.status === 404, "unknown uuid -> 404");
}

console.log("\n[POST 400] missing value");
{
	const r = await call(ctx("/api/sessions", { method: "POST", body: { key: "x" } }));
	assert(r.status === 400, "missing value -> 400");
}

console.log("\n[GET /api/health]");
{
	const r = await call(ctx("/api/health"));
	assert(r.status === 200 && r.json.ok === true, "health ok");
	assert(r.json.backend === "memory", "backend is memory (no env.DB)");
}

console.log("\n[POST /api/sweep] gated");
{
	const r = await call(ctx("/api/sweep", { method: "POST", body: {} }));
	assert(r.status === 403, "sweep disabled without secret");
}

console.log("");
if (failures === 0) {
	console.log("ALL E2E PASSED");
	process.exit(0);
} else {
	console.log(failures + " E2E FAILED");
	process.exit(1);
}
