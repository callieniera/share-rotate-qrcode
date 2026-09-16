const CONSUMER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Viewer · rotating QR share</title>
<meta name="api-base" content="">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div class="wrap">
<header><h1>🔗 Viewer</h1></header>
<section class="panel">
<div class="row between" style="margin-bottom:12px"><span class="badge waiting" id="badge">connecting…</span><span class="status" id="updated">—</span></div>
<div class="value-box" id="value">Waiting for the first scan…</div>
</section>
<details class="panel disclosure"><summary>History</summary><pre id="history" class="value-box" style="max-height:160px;overflow:auto;white-space:pre"></pre></details>
</div>
<script src="/common.js"></script>
<script type="module" src="/consumer.js"></script>
</body>
</html>`;

export function onRequest() {
	return new Response(CONSUMER_HTML, {
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
	});
}
