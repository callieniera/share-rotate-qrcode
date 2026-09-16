// public/consumer.js
//
// Viewer client for a non-scanning user. It reads the session UUID from the URL
// query (?uuid=<uuid>), fetches the latest value, then polls the server for newer
// updates according to the current QR expiry.
//
// Free-tier notes:
//   - Polling uses normal short requests and backs off when there is no valid QR.
//   - Polling PAUSES when the tab is hidden and resumes on focus, saving requests.
//   - When the server reports the session expired, polling stops.

const $ = (id) => document.getElementById(id);

// --- Resolve the session UUID from the hash/query ----------------------------
// Query links are canonical; hash parsing remains for old shared links.
function getUuid() {
	const q = new URLSearchParams(window.location.search).get("uuid");
	if (q) return q;
	const h = window.location.hash.replace(/^#/, "").replace(/^\/+/, "");
	if (!h) return null;
	const seg = h.split("/").filter(Boolean);
	return seg.length ? seg[seg.length - 1] : null; // last segment is the uuid
}

const uuid = getUuid();
let lastId = null; // most recent update id we've seen (poll `since`)
let timer = null;
let stopped = false;
let hasRenderedUpdate = false;
let currentExpiresAt = null;
let expiredRefreshes = 0;
let updatedAgeTimer = null;
let currentValue = null;
let currentSessionExpired = false;
const VALID_DATA_LEAD_MS = 1000;
const EXPIRED_REFRESH_INTERVAL_MS = 2 * 1000;
const MAX_EXPIRED_REFRESHES = 5;
const NO_DATA_REFRESH_INTERVAL_MS = 10 * 1000;

const historyLines = [];
function pushHistory(line) {
	historyLines.unshift(line);
	if (historyLines.length > 30) historyLines.pop();
	$("history").textContent = historyLines.join("\n");
}

function setBadge(status) {
	const badge = $("badge");
	const normalized = status === "active" ? "active" : status === "connecting" ? "connecting" : "expired";
	badge.textContent = normalized[0].toUpperCase() + normalized.slice(1);
	badge.className = "badge " + normalized;
}

function updateDataActions() {
	const actions = $("dataActions");
	const copyButton = $("copyText");
	const openButton = $("openLink");
	if (!actions || !copyButton || !openButton) return;
	const valid = currentValue != null && !currentSessionExpired && (currentExpiresAt == null || currentExpiresAt > Date.now());
	const url = valid ? getHttpUrl(currentValue) : null;
	copyButton.disabled = !valid;
	openButton.disabled = !url;
}

function getHttpUrl(value) {
	try {
		const url = new URL(String(value));
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch (_) {
		return null;
	}
}

function render(view) {
	if (!view || !view.uuid) return;
	currentSessionExpired = view.status === "expired";

	if (view.update && view.update.id != null) {
		const u = view.update;
		hasRenderedUpdate = true;
		lastId = u.id;
		currentValue = u.value == null ? null : String(u.value);
		$("value").textContent = u.value == null ? "—" : u.value;
		$("updated").textContent = SHARE.formatRelative(u.at);
		$("updated").dataset.timestamp = String(u.at);
		startUpdatedAgeTimer();
		if (view.status === "changed") {
			pushHistory(SHARE.formatClock(u.at) + "  " + String(u.value == null ? "" : u.value).slice(0, 120));
		}
	} else if (!hasRenderedUpdate || view.status === "expired") {
		$("value").textContent = view.status === "expired" ? "Session expired" : "Waiting for the first scan…";
	}
	if (view.update) {
		const expiresAt = Number(view.update.expiresAt);
		if (Number.isFinite(expiresAt)) {
			currentExpiresAt = expiresAt;
			if (expiresAt > Date.now()) expiredRefreshes = 0;
		} else {
			currentExpiresAt = null;
		}
	}
	updateUpdatedAge();
	setBadge(view.status === "expired" || currentExpiresAt == null || currentExpiresAt <= Date.now() ? "expired" : "active");
	updateDataActions();
}

function updateUpdatedAge() {
	updateDataActions();
	if (!hasRenderedUpdate) return;
	const timestamp = Number($("updated").dataset.timestamp);
	if (Number.isFinite(timestamp)) {
		const expired = currentSessionExpired || (currentExpiresAt != null && currentExpiresAt <= Date.now());
		$("updated").textContent = (expired ? "expired " : "") + SHARE.formatRelative(timestamp);
	}
}

function startUpdatedAgeTimer() {
	if (updatedAgeTimer) return;
	updatedAgeTimer = setInterval(updateUpdatedAge, 1000);
}

// --- Polling -----------------------------------------------------------------
function scheduleNextPoll() {
	if (stopped || document.hidden) return;
	if (timer) clearTimeout(timer);

	let delayMs;
	if (currentExpiresAt != null && currentExpiresAt > Date.now()) {
		delayMs = Math.max(0, currentExpiresAt - Date.now() - VALID_DATA_LEAD_MS);
	} else if (currentExpiresAt != null && expiredRefreshes < MAX_EXPIRED_REFRESHES) {
		expiredRefreshes += 1;
		delayMs = EXPIRED_REFRESH_INTERVAL_MS;
	} else {
		delayMs = NO_DATA_REFRESH_INTERVAL_MS;
	}
	timer = setTimeout(poll, delayMs);
}

async function poll() {
	if (stopped || !uuid) return;
	setBadge("connecting");
	try {
		const since = lastId == null ? "" : String(lastId);
		const url = SHARE.apiUrl(`/api/sessions/${encodeURIComponent(uuid)}/poll?since=${since}`);
		const res = await fetch(url, { headers: { Accept: "application/json" } });
		if (res.status === 404) {
			stopped = true;
			setBadge("expired");
			$("value").textContent = "Session not found (bad or already expired UUID).";
			pushHistory("This session UUID does not exist or has expired.");
			return;
		}
		if (!res.ok) throw new Error("HTTP " + res.status);
		const view = await res.json();
		render(view);

		// Stop when the session has gone quiet for the TTL.
		if (view.status === "expired") {
			stopped = true;
			setBadge("expired");
			pushHistory("No scanner has uploaded for 5 minutes. The session has expired.");
			return;
		}
	} catch (e) {
		// Transient network error: keep polling but surface it briefly.
		setBadge("connecting");
		pushHistory("network error: " + e.message);
	}
	scheduleNextPoll();
}

function startPolling() {
	if (stopped) return;
	if (timer) clearTimeout(timer);
	timer = null;
	poll();
}

const copyButton = $("copyText");
if (copyButton) {
	copyButton.addEventListener("click", async () => {
		if (currentValue == null) return;
		const copied = await SHARE.copyText(currentValue);
		const original = copyButton.textContent;
		copyButton.textContent = copied === false ? "Copy failed" : "Copied";
		setTimeout(() => (copyButton.textContent = original), 1200);
	});
}

const openButton = $("openLink");
if (openButton) {
	openButton.addEventListener("click", () => {
		const url = getHttpUrl(currentValue);
		const valid = currentValue != null && !currentSessionExpired && (currentExpiresAt == null || currentExpiresAt > Date.now());
		if (url && valid) window.open(url.href, "_blank", "noopener,noreferrer");
	});
}

// Pause when the tab is hidden (saves requests), resume on focus.
document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		if (timer) clearTimeout(timer);
		timer = null;
	} else if (!stopped) {
		startPolling();
	}
});

// --- Boot --------------------------------------------------------------------
async function boot() {
	if (!uuid) {
		$("value").textContent = "No session UUID in the URL. Open a link from the scanner.";
		pushHistory("Get the link from a scanner device, then open it here.");
		return;
	}
	setBadge("connecting");

	// Initial immediate fetch so the page shows data without waiting for a poll
	// window; also validates the UUID exists.
	try {
		const res = await fetch(SHARE.apiUrl(`/api/sessions/${encodeURIComponent(uuid)}`), {
			headers: { Accept: "application/json" },
		});
		if (res.status === 404) {
			stopped = true;
			setBadge("expired");
			$("value").textContent = "Session not found.";
			pushHistory("This session UUID does not exist yet. Open the scanner and copy a fresh link.");
			return;
		}
		const view = await res.json();
		render(view);
	} catch (e) {
		setBadge("connecting");
	}

	startPolling();
}

boot();
