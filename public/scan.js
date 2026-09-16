// public/scan.js
//
// Scanner client. Pipeline:
//   camera frame --(jsQR)--> QR value + location
//                --(Tesseract OCR on the strip BELOW the QR)--> expiry text --> epoch ms
//   { value, rotationAt, expiresAt } --> POST /api/sessions  (throttled)
//   server returns the shared session UUID, which we turn into a copyable share link.
//
// Everything runs in the browser; no camera frames leave the device.
// Expects globals: window.jsQR, window.Tesseract (from CDN), window.SHARE (common.js).

const $ = (id) => document.getElementById(id);

const log = (msg) => {
	const el = $("log");
	const ts = new Date().toLocaleTimeString();
	el.textContent = `[${ts}] ${msg}\n` + el.textContent;
	// Keep the log bounded.
	if (el.textContent.length > 4000) el.textContent = el.textContent.slice(0, 4000);
};

// --- Persistent config (survives reloads) ------------------------------------
const CONFIG_KEY = "srq:config";
function loadConfig() {
	let cfg = {};
	try {
		cfg = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
	} catch (_) {
		cfg = {};
	}
	return Object.assign(
		{
			ocrEnabled: true,
			ocrHint: "QR code valid for: n seconds",
		},
		cfg
	);
}
function saveConfig(cfg) {
	localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}
// --- State -------------------------------------------------------------------
const cfg = loadConfig();
let stream = null;
let activeTrack = null;
let rafId = 0;
let running = false;
let noQrTimer = null;
let zoomSupported = false;

const video = $("video");
const canvas = $("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

let ocrWorker = null;
let ocrBusy = false;
let lastOcrStart = 0;
let ocrRetryTimer = null;
let currentQrLocation = null;

// The "current" payload we keep uploading. `value`/`rotationAt` come from the QR;
// `expiresAt` comes from the most recent OCR for the *current* rotation.
let current = { value: null, rotationAt: null, expiresAt: null, expiryFallback: false };
let pendingUpload = false;
let lastUploadAt = 0;
let uploadAgeTimer = null;
let lastValue = null;
let currentUuid = null;
let lastOcrRaw = null;
let lastQrSeenAt = 0;
const QR_VALID_WINDOW_MS = 2000;

// --- Expiry parsing ----------------------------------------------------------
// The expiry text is whatever is printed under the QR. We don't control its format,
// so this is intentionally tolerant and the raw + parsed result is logged for
// debugging. Modes:
//   - "epoch": a run of digits -> ms (len>=13) or seconds (len 10) *1000
//   - otherwise try Date.parse on a cleaned string
function parseExpiry(raw) {
	if (raw == null) return null;
	const seconds = String(raw).match(/(\d+)\s*s\s*e\s*c\s*(?:o|0)\s*n\s*(?:d|c\s*[iIl1])\s*s?\b/i);
	if (seconds) return Date.now() + Number(seconds[1]) * 1000;
	const s = String(raw)
		.replace(/[^0-9:\.\-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (s === "") return null;

	// Pure digits -> epoch.
	const digitsOnly = s.replace(/\D/g, "");
	if (digitsOnly === s) {
		if (digitsOnly.length >= 13) return parseInt(digitsOnly, 10); // ms
		if (digitsOnly.length === 10) return parseInt(digitsOnly, 10) * 1000; // seconds
		return null;
	}
	// Try a clock/date interpretation (e.g. "14:30:05", "14:30").
	let t = Date.parse(s);
	if (Number.isFinite(t)) return t;
	// "HH:MM:SS" / "MM:SS" as a time today.
	const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
	if (m) {
		const d = new Date();
		d.setHours(+m[1], +m[2], m[3] ? +m[3] : 0, 0);
		return d.getTime();
	}
	return null;
}

// --- Camera ------------------------------------------------------------------
async function startCamera() {
	stopCamera();
	const constraints = {
		video: { facingMode: { ideal: "environment" } },
		audio: false,
	};
	try {
		stream = await navigator.mediaDevices.getUserMedia(constraints);
		activeTrack = stream.getVideoTracks()[0] || null;
		for (const track of stream.getTracks()) track.addEventListener("ended", stopCamera, { once: true });
		video.srcObject = stream;
		await video.play();
		running = true;
		setupZoomControl();
		noQrTimer = setTimeout(() => {
			if (running && !lastQrSeenAt) {
				const detail = zoomSupported ? "No QR code was decoded." : "This device does not support camera zoom, and no QR code was decoded.";
				alert(detail + " Check the camera view and QR code, then try again.");
				log(detail);
			}
		}, 10000);
		$("btnStart").disabled = true;
		$("btnStop").disabled = false;
		$("camStatus").textContent = "Camera running.";
		log("camera started");
		scheduleDecode();
	} catch (e) {
		log("camera error: " + e.message);
		$("camStatus").textContent = "Camera unavailable: " + e.message;
		$("btnStart").disabled = false;
	}
}

function stopCamera() {
	running = false;
	if (ocrRetryTimer) {
		clearTimeout(ocrRetryTimer);
		ocrRetryTimer = null;
	}
	if (noQrTimer) {
		clearTimeout(noQrTimer);
		noQrTimer = null;
	}
	lastQrSeenAt = 0;
	lastValue = null;
	if (uploadTimer) {
		clearTimeout(uploadTimer);
		uploadTimer = null;
	}
	if (heartbeat) {
		clearInterval(heartbeat);
		heartbeat = null;
	}
	if (rafId) cancelAnimationFrame(rafId);
	rafId = 0;
	if (stream) {
		for (const t of stream.getTracks()) t.stop();
		stream = null;
	}
	activeTrack = null;
	zoomSupported = false;
	$("zoomControl").classList.add("hidden");
	video.srcObject = null;
	$("btnStart").disabled = false;
	$("btnStop").disabled = true;
	$("camStatus").textContent = "Camera stopped.";
}

// Decode loop. Uses requestVideoFrameCallback when available (fires per new video
// frame) and otherwise requestAnimationFrame; both are throttled to a low rate
// because decoding + OCR are expensive and the QR only rotates every ~30s.
const DECODE_INTERVAL_MS = 500; // ~2 fps
let lastDecode = 0;

function scheduleDecode() {
	const step = () => {
		if (!running) return;
		const now = performance.now();
		if (now - lastDecode >= DECODE_INTERVAL_MS) {
			lastDecode = now;
			decodeFrame();
		}
		if (video.requestVideoFrameCallback) {
			video.requestVideoFrameCallback(step);
		} else {
			rafId = requestAnimationFrame(step);
		}
	};
	if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(step);
	else rafId = requestAnimationFrame(step);
}

function decodeFrame() {
	if (!video.videoWidth || !video.videoHeight) return;
	canvas.width = video.videoWidth;
	canvas.height = video.videoHeight;
	ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
	const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	if (typeof window.jsQR === "undefined") {
		log("jsQR not loaded yet; retrying…");
		return;
	}
	const result = window.jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "attemptBoth" });
	if (!result || !result.data) return;

	const value = String(result.data);
	lastQrSeenAt = Date.now();
	if (noQrTimer) {
		clearTimeout(noQrTimer);
		noQrTimer = null;
	}
	if (value !== lastValue) {
		// A rotation (or first detection).
		log("QR detected/rotated: " + truncate(value, 60));
		onNewRotation(value, result.location);
	}
}

// --- Rotation handling -------------------------------------------------------
function onNewRotation(value, location) {
	if (ocrRetryTimer) {
		clearTimeout(ocrRetryTimer);
		ocrRetryTimer = null;
	}
	lastValue = value;
	currentQrLocation = location;
	current.value = value;
	current.rotationAt = Date.now();
	current.expiresAt = Date.now() + 15000; // safe fallback until OCR succeeds
	current.expiryFallback = true;
	pendingUpload = true;
	renderSession();

	if (cfg.ocrEnabled && location) {
		startOcr(location);
		scheduleOcrRetry(value);
	}
	scheduleUpload();
}

// OCR the strip directly BELOW the QR (where the expiry is printed).
function startOcr(location) {
	if (!cfg.ocrEnabled || !hasValidQr()) return;
	const now = performance.now();
	if (ocrBusy || now - lastOcrStart < 1500) return; // throttle
	if (typeof window.Tesseract === "undefined") {
		log("Tesseract not loaded yet; skipping OCR this round.");
		return;
	}
	const region = stripBelowQr(location, canvas.width, canvas.height);
	if (!region) return;

	ocrBusy = true;
	lastOcrStart = now;
	const rotationValue = current.value;
	let parsedExpiry = null;
	getOcrWorker()
		.then((worker) => worker.recognize(region, { user_patterns: cfg.ocrHint || "QR code valid for: n seconds" }))
		.then(({ data }) => {
			const raw = (data && data.text ? data.text : "").replace(/\n/g, " ").trim();
			lastOcrRaw = raw;
			parsedExpiry = parseExpiry(raw);
			log('OCR: "' + raw + '" -> ' + (parsedExpiry ? new Date(parsedExpiry).toISOString() : "unparsed"));
			// Only apply if this is still the current rotation.
			if (raw && parsedExpiry && lastValue === rotationValue && lastValue === current.value) {
				current.expiresAt = parsedExpiry;
				current.expiryFallback = false;
				pendingUpload = true;
				renderSession();
				scheduleUpload();
			}
		})
		.catch((e) => log("OCR error: " + e.message))
		.finally(() => {
			ocrBusy = false;
			if (!parsedExpiry && cfg.ocrEnabled && hasValidQr() && lastValue === rotationValue && current.expiryFallback) {
				scheduleOcrRetry(rotationValue);
			}
		});
}

function scheduleOcrRetry(rotationValue) {
	if (ocrRetryTimer) return;
	ocrRetryTimer = setTimeout(() => {
		ocrRetryTimer = null;
		if (cfg.ocrEnabled && hasValidQr() && lastValue === rotationValue && current.expiryFallback && currentQrLocation) {
			startOcr(currentQrLocation);
		}
	}, 1600);
}

// Compute the source-pixel rect for the text strip below the QR and render it to a
// scaled-up canvas for better OCR accuracy.
function stripBelowQr(location, frameW, frameH) {
	const tl = location.topLeftCorner;
	const tr = location.topRightCorner;
	const bl = location.bottomLeftCorner;
	const br = location.bottomRightCorner;
	if (!tl || !tr || !bl || !br) return null;

	const minX = Math.min(tl.x, bl.x);
	const maxX = Math.max(tr.x, br.x);
	const minY = Math.min(tl.y, tr.y);
	const maxY = Math.max(bl.y, br.y);
	const qrW = Math.max(1, maxX - minX);
	const qrH = Math.max(1, maxY - minY);

	const pad = Math.round(qrW * 0.15);
	const left = clamp(minX - pad, 0, frameW);
	const right = clamp(maxX + pad, 0, frameW);
	const top = clamp(maxY, 0, frameH);
	// The expiry sits just under the QR; grab a strip about as tall as the QR.
	const stripH = Math.round(qrH * 0.8);
	const bottom = clamp(top + stripH, 0, frameH);
	if (bottom <= top) return null;

	const w = right - left;
	const h = bottom - top;
	const out = document.createElement("canvas");
	const targetH = 120; // upscale short strips for the OCR engine
	const scale = targetH / h;
	out.width = Math.max(1, Math.round(w * scale));
	out.height = targetH;
	const octx = out.getContext("2d");
	octx.imageSmoothingEnabled = true;
	octx.drawImage(canvas, left, top, w, h, 0, 0, out.width, out.height);
	return out;
}

async function getOcrWorker() {
	if (ocrWorker) return ocrWorker;
	ocrWorker = await window.Tesseract.createWorker("eng");
	return ocrWorker;
}

// --- Upload ------------------------------------------------------------------
// Coalesce bursts of detections briefly while ensuring the latest value reaches
// the server promptly.
function scheduleUpload() {
	if (uploadTimer) return;
	uploadTimer = setTimeout(flushUpload, 120);
}
let uploadTimer = null;
async function flushUpload() {
	uploadTimer = null;
	if (!hasValidQr()) return;
	if (!pendingUpload && Date.now() - lastUploadAt < 5000) return;
	await upload();
}

function hasValidQr() {
	return running && current.value != null && Date.now() - lastQrSeenAt <= QR_VALID_WINDOW_MS;
}

async function upload() {
	if (!hasValidQr()) return;
	if (current.expiryFallback) current.expiresAt = Date.now() + 15000;
	const body = {
		uuid: currentUuid,
		value: current.value,
		rotationAt: current.rotationAt,
		expiresAt: current.expiresAt,
		expiryFallback: current.expiryFallback,
	};
	try {
		const res = await fetch(SHARE.apiUrl("/api/sessions"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error("HTTP " + res.status);
		const data = await res.json();
		currentUuid = data.uuid;
		const matchedExpiresAt = Number(data.matchedUpdate && data.matchedUpdate.expiresAt);
		if (
			data.matchedUpdate &&
			String(data.matchedUpdate.value) === String(current.value) &&
			Number.isFinite(matchedExpiresAt) &&
			matchedExpiresAt > Date.now()
		) {
			current.expiresAt = matchedExpiresAt;
			current.expiryFallback = false;
		}
		lastUploadAt = Date.now();
		startUploadAgeTimer();
		pendingUpload = false;
		log("uploaded -> session " + data.uuid + " (" + data.status + ")");
		renderSession();
	} catch (e) {
		log("upload failed: " + e.message + " (will retry)");
	}
	// Heartbeat so the consumer keeps seeing "active" even without new rotations.
	scheduleHeartbeat();
}

let heartbeat = null;
function updateLastUpload() {
	if (!lastUploadAt || !hasValidQr()) return;
	$("lastUpload").textContent = "Last upload " + SHARE.formatRelative(lastUploadAt);
}

function startUploadAgeTimer() {
	if (uploadAgeTimer) return;
	uploadAgeTimer = setInterval(updateLastUpload, 1000);
}

function scheduleHeartbeat() {
	if (heartbeat) return;
	heartbeat = setInterval(() => {
		// Re-upload the current value to refresh last_upload_at and keep the
		// fallback session within its TTL until OCR resolves the expiry or a
		// real rotation supersedes it. Once OCR provides an expiry, the server
		// should not receive renewal data until the QR rotates.
		if (hasValidQr() && current.expiryFallback) {
			pendingUpload = true;
			upload();
		}
	}, 5000);
}

function setupZoomControl() {
	const control = $("zoomControl");
	const value = $("zoomValue");
	if (!activeTrack || !activeTrack.getCapabilities) {
		control.classList.add("hidden");
		return;
	}
	const zoom = activeTrack.getCapabilities().zoom;
	if (!zoom || zoom.min == null || zoom.max == null) {
		control.classList.add("hidden");
		return;
	}
	zoomSupported = true;
	control.classList.remove("hidden");
	value.min = zoom.min;
	value.max = zoom.max;
	value.step = zoom.step || 0.1;
	value.value = activeTrack.getSettings().zoom || zoom.min;
	value.oninput = async () => {
		try {
			await activeTrack.applyConstraints({ advanced: [{ zoom: Number(value.value) }] });
		} catch (e) {
			log("zoom unavailable: " + e.message);
		}
	};
}

// --- Rendering ---------------------------------------------------------------
function renderSession() {
	$("lastValue").textContent = current.value != null ? truncate(current.value, 80) : "—";
	$("lastValue").title = current.value || "";

	const badge = $("badgeStatus");
	if (currentUuid) {
		badge.textContent = "active";
		badge.className = "badge active";
		const full = new URL("./c?uuid=" + encodeURIComponent(currentUuid), window.location.href).href;
		$("shareLink").value = full;
		$("lastUpload").textContent = "Last upload " + SHARE.formatRelative(lastUploadAt || Date.now());
	} else {
		badge.textContent = current.value ? "scanning…" : "idle";
		badge.className = "badge waiting";
		$("shareLink").value = "";
	}
}

// --- UI wiring ---------------------------------------------------------------
function bindControls() {
	$("btnStart").onclick = startCamera;
	$("btnStop").onclick = stopCamera;

	$("shareLink").onclick = () => {
		const v = $("shareLink").value;
		if (!v) return;
		$("shareLink").select();
		SHARE.copyText(v);
	};

	const oc = $("ocrEnabled");
	oc.checked = cfg.ocrEnabled;
	oc.onchange = () => {
		cfg.ocrEnabled = oc.checked;
		saveConfig(cfg);
	};

	const oh = $("ocrHint");
	oh.value = cfg.ocrHint || "QR code valid for: n seconds";
	oh.oninput = () => {
		cfg.ocrHint = oh.value;
		saveConfig(cfg);
	};
}

// --- Utilities ---------------------------------------------------------------
function truncate(s, n) {
	s = String(s == null ? "" : s);
	return s.length > n ? s.slice(0, n) + "…" : s;
}
function clamp(v, lo, hi) {
	return Math.max(lo, Math.min(hi, v));
}

// Kick things off.
bindControls();
renderSession();
log("scanner ready");
