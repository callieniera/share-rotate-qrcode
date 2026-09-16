import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const configPath = resolve(root, "wrangler.jsonc");
const databaseRecordPath = resolve(root, ".d1-db-id");
const databaseName = "share-rotate-qrcode-db";
const placeholder = "REPLACE_WITH_YOUR_D1_DATABASE_ID";
const wrangler = process.platform === "win32" ? "npx.cmd" : "npx";

function runWrangler(args, options = {}) {
	return execFileSync(wrangler, ["wrangler", ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: options.stdio || ["ignore", "pipe", "inherit"],
	});
}

function validId(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function idFromJsonOutput(output) {
	const start = output.search(/[\[{]/);
	if (start < 0) return null;
	try {
		const parsed = JSON.parse(output.slice(start));
		const rows = Array.isArray(parsed) ? parsed : parsed.result || parsed.databases || [];
		const row = rows.find((item) => item.name === databaseName || item.database_name === databaseName);
		return row?.uuid || row?.id || row?.database_id || null;
	} catch (_) {
		return null;
	}
}

function idFromCreateOutput(output) {
	const match = output.match(/database_id["']?\s*[:=]\s*["']([0-9a-f-]{36})["']/i);
	return match ? match[1] : null;
}

function readConfiguredId(config) {
	const match = config.match(/"database_id"\s*:\s*"([^"]+)"/);
	return match ? match[1] : null;
}

function setConfiguredId(config, id) {
	const updated = config.replace(/("database_id"\s*:\s*")[^"]+(")/, `$1${id}$2`);
	if (updated === config) throw new Error("Could not update database_id in wrangler.jsonc");
	writeFileSync(configPath, updated);
}

const originalConfig = readFileSync(configPath, "utf8");
let config = originalConfig;
let databaseId = readConfiguredId(config);
const managesLocalConfig = !validId(databaseId || "");

if (!validId(databaseId || "")) {
	if (existsSync(databaseRecordPath)) {
		const recorded = readFileSync(databaseRecordPath, "utf8").trim();
		if (validId(recorded)) databaseId = recorded;
	}
}

if (!validId(databaseId || "")) {
	console.log(`Looking for D1 database '${databaseName}'...`);
	databaseId = idFromJsonOutput(runWrangler(["d1", "list", "--json"]));
}

if (!validId(databaseId || "")) {
	console.log(`Creating D1 database '${databaseName}'...`);
	databaseId = idFromCreateOutput(runWrangler(["d1", "create", databaseName, "--binding", "DB", "--update-config=false"]));
}

if (!validId(databaseId || "")) {
	throw new Error("Could not determine the D1 database ID. Run `npx wrangler d1 list` and check your Cloudflare login.");
}

if (readConfiguredId(config) !== databaseId) {
	setConfiguredId(config, databaseId);
	console.log("Updated wrangler.jsonc with the local account database ID.");
}
writeFileSync(databaseRecordPath, `${databaseId}\n`);

try {
	console.log("Applying the remote D1 schema...");
	runWrangler(["d1", "execute", databaseName, "--remote", "--yes", "--file=migrations/0001_init.sql"], { stdio: "inherit" });
	console.log("Deploying Pages...");
	runWrangler(["pages", "deploy", "public"], { stdio: "inherit" });
} finally {
	if (managesLocalConfig) {
		writeFileSync(configPath, originalConfig);
		console.log("Restored the placeholder database ID in wrangler.jsonc.");
	}
}
