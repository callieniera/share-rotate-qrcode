// public/consumer.js
//
// Viewer client for a non-scanning user. It reads the session UUID from the URL
// query (?uuid=<uuid>), fetches the latest value, then *short-polls* the server for
// newer updates (goal 5: "long-pulling to get the latest decoded data").
//
// Free-tier notes:
//   - Polling is a short request (~2.5s server hold, capped to <10s on the server),
//     not an open-ended connection, so it stays within the Pages request budget.
//   - Polling PAUSES when the tab is hidden and resumes on focus, saving requests.
//   - When the server reports the session expired (goal 7), polling stops.

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
const POLL_WAIT_SEC = 3; // client-requested server hold window

const historyLines = [];
function pushHistory(line) {
	historyLines.unshift(line);
	if (historyLines.length > 30) historyLines.pop();
	$("history").textContent = historyLines.join("\n");
}

function setStatus(status) {
	const badge = $("badge");
	const map = {
		active: ["active", "active"],
		changed: ["active", "active"],
		unchanged: ["active", "live"],
		expired: ["expired", "expired"],
		waiting: ["waiting", "waiting for first scan"],
		error: ["error", "error"],
	};
	const [cls, label] = map[status] || map.waiting;
	badge.textContent = label;
	badge.className = "badge " + cls;
}

function render(view) {
	if (!view || !view.uuid) return;

	if (view.update && view.update.id != null) {
		const u = view.update;
		lastId = u.id;
		$("value").textContent = u.value == null ? "—" : u.value;
		$("updated").textContent = SHARE.formatRelative(u.at);
		if (view.status === "changed") {
			pushHistory(SHARE.formatClock(u.at) + "  " + String(u.value == null ? "" : u.value).slice(0, 120));
		}
	} else {
		$("value").textContent = view.status === "expired" ? "Session expired" : "Waiting for the first scan…";
	}
	setStatus(view.status);
}

// --- Polling -----------------------------------------------------------------
async function poll() {
	if (stopped || !uuid) return;
	try {
		const since = lastId == null ? "" : String(lastId);
		const url = SHARE.apiUrl(`/api/sessions/${encodeURIComponent(uuid)}/poll?since=${since}&wait=${POLL_WAIT_SEC}`);
		const res = await fetch(url, { headers: { Accept: "application/json" } });
		if (res.status === 404) {
			stopped = true;
			setStatus("error");
			$("value").textContent = "Session not found (bad or already expired UUID).";
			pushHistory("This session UUID does not exist or has expired.");
			return;
		}
		const view = await res.json();
		render(view);

		// Stop when the session has gone quiet for the TTL (goal 7).
		if (view.status === "expired") {
			stopped = true;
			pushHistory("No scanner has uploaded for 5 minutes. The session has expired.");
			return;
		}
	} catch (e) {
		// Transient network error: keep polling but surface it briefly.
		setStatus("error");
		pushHistory("network error: " + e.message);
	}
	// Schedule the next poll. Use a short gap so a `changed`/`unchanged` response
	// triggers a fresh request quickly; the server holds the request up to its
	// window so we are not busy-looping.
	timer = setTimeout(poll, 250);
}

function startPolling() {
	if (stopped) return;
	if (timer) clearTimeout(timer);
	poll();
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
	setStatus("waiting");

	// Initial immediate fetch so the page shows data without waiting for a poll
	// window; also validates the UUID exists.
	try {
		const res = await fetch(SHARE.apiUrl(`/api/sessions/${encodeURIComponent(uuid)}`), {
			headers: { Accept: "application/json" },
		});
		if (res.status === 404) {
			stopped = true;
			setStatus("error");
			$("value").textContent = "Session not found.";
			pushHistory("This session UUID does not exist yet. Open the scanner and copy a fresh link.");
			return;
		}
		const view = await res.json();
		render(view);
	} catch (e) {
		setStatus("error");
	}

	startPolling();
}

boot();
