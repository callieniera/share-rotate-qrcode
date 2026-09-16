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

	async function shareURL(url) {
		const shareData = { url: url };
		if (navigator.canShare && navigator.canShare(shareData)) {
			try {
				await navigator.share(shareData);
			} catch (err) {
				if (err.name !== "AbortError") copyText(url);
			}
		} else copyText(url);
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

	// Page metadata. Kept here (not hard-coded into the HTML) so the footer text,
	// repository link, and version live in one place and stay in sync across every
	// page. Set any field to "" to hide that part of the footer. Bump `version`
	// to match the "version" field in package.json.
	const META = {
		// GitHub repository. Leave "" to hide the link.
		repoUrl: "https://github.com/callieniera/share-rotate-qrcode",
		// Shown next to the repo link, e.g. "v1.0.0". Leave "" to hide.
		version: "0.1.0",
		// Display name shown in the footer. Leave "" to hide.
		name: "share-rotate-qrcode",
	};

	// Fill the first `[data-footer]` element found in the given root (defaults to
	// the document) with the shared footer. Safe to call when the target is
	// absent — it just returns null. Returns the element it rendered into.
	function renderFooter(root = document) {
		const el = root.querySelector("[data-footer]");
		if (!el) return null;

		el.textContent = "";
		el.removeAttribute("hidden");

		// Left side: name · version
		const leftParts = [];
		if (META.name) leftParts.push(META.name);
		if (META.version) leftParts.push("v" + META.version);
		if (leftParts.length) {
			const left = document.createElement("span");
			left.className = "footer-copy";
			left.textContent = leftParts.join(" · ");
			el.appendChild(left);
		}

		// Right side: repository link.
		if (META.repoUrl) {
			const link = document.createElement("a");
			link.className = "footer-link";
			link.href = META.repoUrl;
			link.textContent = "GitHub";
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			link.setAttribute("aria-label", "Open the GitHub repository");
			el.appendChild(link);
		}

		return el;
	}

	// Render the footer now (the placeholder lives in the DOM by the time this
	// runs) and expose it for manual refresh / testing.
	renderFooter();

	window.SHARE = { shareURL, apiUrl, copyText, escapeHtml, formatRelative, formatDur, formatClock, renderFooter, META, API_BASE };
})();
