-- 0001_init.sql
-- Schema for rotating-QR sharing.
--
-- The existing database is intentionally reset because the old `key` model is
-- incompatible with rotating QR values.
DROP TABLE IF EXISTS updates;
DROP TABLE IF EXISTS sessions;

-- sessions : one row per shareable session. `current_value` is the latest QR
-- payload associated with the session and is used for exact-value lookup.
-- updates  : append-only log of decoded values pushed to a session, most recent
--            first. `last_upload_at` on the session drives the 30-minute expiry
--            (goal 7).

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,            -- session UUID (the shareable secret)
  current_value  TEXT,                        -- latest QR payload (nullable, unique)
  created_at     INTEGER NOT NULL,            -- epoch ms
  last_upload_at INTEGER NOT NULL             -- epoch ms of the most recent update
);

-- SQLite treats every NULL as distinct, so a partial index permits sessions with
-- no current value while preventing duplicate current QR values.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_current_value
  ON sessions (current_value) WHERE current_value IS NOT NULL;

CREATE TABLE IF NOT EXISTS updates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  value       TEXT,                           -- decoded QR text (the shared payload)
  rotation_at INTEGER,                        -- when this rotation was captured (epoch ms)
  expires_at  INTEGER,                        -- OCR'd expiry printed under the QR (epoch ms)
  expiry_fallback INTEGER NOT NULL DEFAULT 1, -- 1 until OCR or another scanner confirms expiry
  created_at  INTEGER NOT NULL,               -- epoch ms
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

-- Fast "latest update for a session" lookups (polling + GET).
CREATE INDEX IF NOT EXISTS idx_updates_session_id
  ON updates (session_id, id DESC);
