/* global window */
// Shared browser helpers used by both the scanner (scan.js) and the consumer
// (consumer.js). Exposed as window.SHARE.
(function () {
	// API base defaults to same-origin (the Pages Functions live on the same site).
	// Override with a <meta name="api-base"> tag or window.__API_BASE__.
	const meta = document.querySelector('meta[name="api-base"]');
	const API_BASE = (window.__API_BASE__ || (meta && meta.content) || "").replace(/\/+$/, "");

	function apiUrl(path) {
		return API_BASE + path;
	}

	// Copy text to the clipboard with a legacy fallback (some browsers/contexts).
	function copyText(text) {
		if (navigator.clipboard && window.isSecureContext) {
			return navigator.clipboard.writeText(String(text));
		}
		const ta = document.createElement("textarea");
		ta.value = String(text);
		ta.setAttribute("readonly", "");
		ta.style.position = "absolute";
		ta.style.left = "-9999px";
		document.body.appendChild(ta);
		ta.select();
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} catch (_) {
			ok = false;
		}
		document.body.removeChild(ta);
		return Promise.resolve(ok);
	}

	function escapeHtml(s) {
		return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	}

	function formatDur(ms) {
		const s = Math.round(ms / 1000);
		if (s < 60) return s + "s";
		const m = Math.floor(s / 60);
		if (m < 60) return m + "m " + (s % 60) + "s";
		const h = Math.floor(m / 60);
		return h + "h " + (m % 60) + "m";
	}

	// Human "3m ago" / "in 2m" relative time.
	function formatRelative(ts, now = Date.now()) {
		if (!ts) return "—";
		const d = now - ts;
		if (d < 0) return "in " + formatDur(-d);
		return formatDur(d) + " ago";
	}

	function formatClock(ts) {
		if (!ts) return "—";
		const d = new Date(ts);
		return d.toLocaleString();
	}

	window.SHARE = { apiUrl, copyText, escapeHtml, formatRelative, formatDur, formatClock, API_BASE };
})();
