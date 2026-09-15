-- 0001_init.sql
-- Schema for rotating-QR sharing.
--
-- sessions : one row per shareable session. `key` is the client-supplied session
--            key (NULL when the client did not provide one). A partial UNIQUE index
--            on `key` (ignoring NULLs) guarantees "same key => same session/uuid",
--            which is the crux of goals 4 & 6 (same QR -> same session, even across
--            different scanners). Each new keyless upload always creates a fresh
--            session.
-- updates  : append-only log of decoded values pushed to a session, most recent
--            first. `last_upload_at` on the session drives the 5-minute expiry
--            (goal 7).

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,            -- session UUID (the shareable secret)
  key            TEXT,                        -- client session key (nullable, unique)
  created_at     INTEGER NOT NULL,            -- epoch ms
  last_upload_at INTEGER NOT NULL             -- epoch ms of the most recent update
);

-- SQLite treats every NULL as distinct, so a plain UNIQUE(key) would forbid more
-- than one keyless session. A partial index enforces uniqueness only for real
-- (non-NULL) keys and lets any number of keyless sessions coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_key
  ON sessions (key) WHERE key IS NOT NULL;

CREATE TABLE IF NOT EXISTS updates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  value       TEXT,                           -- decoded QR text (the shared payload)
  rotation_at INTEGER,                        -- when this rotation was captured (epoch ms)
  expires_at  INTEGER,                        -- OCR'd expiry printed under the QR (epoch ms)
  created_at  INTEGER NOT NULL,               -- epoch ms
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

-- Fast "latest update for a session" lookups (polling + GET).
CREATE INDEX IF NOT EXISTS idx_updates_session_id
  ON updates (session_id, id DESC);
