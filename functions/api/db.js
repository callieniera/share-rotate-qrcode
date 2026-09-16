// functions/api/db.js
//
// Session + update store for the rotating-QR sharing API.
//
// The store is intentionally backend-agnostic so the same API code runs:
//    - against D1 (the production SQLite) when the `DB` Pages binding is present, and
//    - against a simple in-memory Map when it is not (local dev without D1, or any
//      environment where the binding is absent). The in-memory store keeps the demo
//      runnable end-to-end without a database.
//
// All queries funnel through `storeFor(env)` which picks the backend and returns an
// object implementing the small interface documented on `SessionStore`.

// Goal 7: a session with no upload for this long is considered expired.
export const SESSION_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// D1 backend
// ---------------------------------------------------------------------------
class D1SessionStore {
   constructor(db) {
      this.db = db;
      this._ready = null;
   }

    // Idempotent schema bootstrap so local `wrangler pages dev` works without a
    // manual migration step. On remote the migration file is the source of truth;
    // these `IF NOT EXISTS` statements are harmless alongside it.
   async ensureSchema() {
      if (this._ready) return this._ready;
      this._ready = (async () => {
         await this.db.batch([
            this.db.prepare(
                'CREATE TABLE IF NOT EXISTS sessions (' +
                  'id TEXT PRIMARY KEY, current_value TEXT, created_at INTEGER NOT NULL, last_upload_at INTEGER NOT NULL)'
             ),
            this.db.prepare(
               'CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_current_value ON sessions (current_value) WHERE current_value IS NOT NULL'
             ),
            this.db.prepare(
                'CREATE TABLE IF NOT EXISTS updates (' +
                   'id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, value TEXT, ' +
                   'rotation_at INTEGER, expires_at INTEGER, created_at INTEGER NOT NULL, ' +
                   'FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE)'
             ),
            this.db.prepare(
                'CREATE INDEX IF NOT EXISTS idx_updates_session_id ON updates (session_id, id DESC)'
             ),
          ]);
        })();
      return this._ready;
   }

   async createOrReuseSession(uuid, value, now) {
      await this.ensureSchema();
      const cutoff = now - SESSION_TTL_MS;
      if (uuid) {
         const known = await this.db
            .prepare('SELECT id FROM sessions WHERE id = ? AND last_upload_at >= ?')
            .bind(uuid, cutoff)
            .first();
         if (known) {
            await this.db.prepare('UPDATE sessions SET current_value = ? WHERE id = ?').bind(value, known.id).run();
            return known.id;
         }
      }
      if (value == null) {
         const id = crypto.randomUUID();
         await this.db
             .prepare('INSERT INTO sessions (id, current_value, created_at, last_upload_at) VALUES (?, NULL, ?, ?)')
             .bind(id, now, now)
             .run();
         return id;
      }

        const existing = await this.db
          .prepare('SELECT id FROM sessions WHERE current_value = ? AND last_upload_at >= ?')
          .bind(value, cutoff)
         .first();
      if (existing) return existing.id;

      const id = crypto.randomUUID();
      await this.db
          .prepare(
           'INSERT OR IGNORE INTO sessions (id, current_value, created_at, last_upload_at) VALUES (?, ?, ?, ?)'
          )
           .bind(id, value, now, now)
          .run();

        const row = await this.db.prepare('SELECT id FROM sessions WHERE current_value = ?').bind(value).first();
      return row.id;
    }

   async appendUpdate(uuid, update, now) {
      await this.ensureSchema();
      await this.db
          .prepare(
             'INSERT INTO updates (session_id, value, rotation_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
          )
          .bind(uuid, update.value, update.rotation_at, update.expires_at, now)
          .run();
      await this.db.prepare('UPDATE sessions SET last_upload_at = ? WHERE id = ?').bind(now, uuid).run();
    }

   async getLatest(uuid) {
      await this.ensureSchema();
      return this.db
          .prepare(
             'SELECT id, value, rotation_at, expires_at, created_at FROM updates ' +
                'WHERE session_id = ? ORDER BY id DESC LIMIT 1'
          )
          .bind(uuid)
          .first();
    }

   async getLastUploadAt(uuid) {
      await this.ensureSchema();
      const row = await this.db.prepare('SELECT last_upload_at FROM sessions WHERE id = ?').bind(uuid).first();
      return row ? row.last_upload_at : null;
    }

    // "Newer update than a given baseline". `since` is an update id, or the empty
    // string/null to mean "give me whatever is latest".
   async getUpdateAfter(uuid, since) {
      await this.ensureSchema();
      const id = this._num(since);
      if (id == null) return this.getLatest(uuid);
      return this.db
          .prepare(
             'SELECT id, value, rotation_at, expires_at, created_at FROM updates ' +
                'WHERE session_id = ? AND id > ? ORDER BY id DESC LIMIT 1'
          )
          .bind(uuid, id)
          .first();
    }

   async sweep(now, ttl) {
      await this.ensureSchema();
      const cutoff = now - ttl;
      const sess = await this.db.prepare('DELETE FROM sessions WHERE last_upload_at < ?').bind(cutoff).run();
      const upd = await this.db.prepare('DELETE FROM updates WHERE created_at < ?').bind(cutoff).run();
      return { sessions: sess.successfulChanges || 0, updates: upd.successfulChanges || 0 };
    }

    _num(v) {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
}

// ---------------------------------------------------------------------------
// In-memory backend (dev / no-DB fallback)
// ---------------------------------------------------------------------------
class MemorySessionStore {
   constructor() {
      this.sessions = new Map(); // id -> { current_value, created_at, last_upload_at }
      this.updates = new Map(); // id -> { id, session_id, value, rotation_at, expires_at, created_at }
      this._seq = 0;
    }

   async createOrReuseSession(uuid, value, now) {
      const cutoff = now - SESSION_TTL_MS;
      const known = uuid && this.sessions.get(uuid);
      if (known && known.last_upload_at >= cutoff) {
         known.current_value = value;
         return known.id;
      }
      if (value != null) {
         for (const s of this.sessions.values()) {
            if (s.current_value === value && s.last_upload_at >= cutoff) return s.id;
          }
      }
      const id = crypto.randomUUID();
      this.sessions.set(id, { id, current_value: value ?? null, created_at: now, last_upload_at: now });
      return id;
   }

   async appendUpdate(uuid, update, now) {
      const id = ++this._seq;
      const row = {
         id,
         session_id: uuid,
         value: update.value,
         rotation_at: update.rotation_at ?? null,
         expires_at: update.expires_at ?? null,
         created_at: now,
      };
      this.updates.set(id, row);
      const sess = this.sessions.get(uuid);
      if (sess) sess.last_upload_at = now;
   }

   async getLatest(uuid) {
      let latest = null;
      for (const u of this.updates.values()) {
         if (u.session_id !== uuid) continue;
         if (!latest || u.id > latest.id) latest = u;
      }
      return latest ? { ...latest } : null;
   }

   async getLastUploadAt(uuid) {
      const s = this.sessions.get(uuid);
      return s ? s.last_upload_at : null;
   }

   async getUpdateAfter(uuid, since) {
      const id = this._num(since);
      if (id == null) return this.getLatest(uuid);
      let latest = null;
      for (const u of this.updates.values()) {
         if (u.session_id !== uuid || u.id <= id) continue;
         if (!latest || u.id > latest.id) latest = u;
      }
      return latest ? { ...latest } : null;
   }

   async sweep(now, ttl) {
      const cutoff = now - ttl;
      let sessions = 0;
      for (const [id, s] of [...this.sessions]) {
         if (s.last_upload_at < cutoff) {
            this.sessions.delete(id);
            sessions++;
          }
      }
      let updates = 0;
      for (const [id, u] of [...this.updates]) {
         if (u.created_at < cutoff) {
            this.updates.delete(id);
            updates++;
          }
      }
      return { sessions, updates };
   }

    _num(v) {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
}

// ---------------------------------------------------------------------------
// Selection + shared helpers
// ---------------------------------------------------------------------------
const memory = new MemorySessionStore();

// Returns a store for this request. Prefers D1; falls back to the in-memory store.
export function storeFor(env) {
   const db = env && env.DB;
   if (db && typeof db.prepare === 'function') return new D1SessionStore(db);
   return memory;
}

// Normalize a raw update payload to the stored shape (all epoch-ms integers or null).
export function normalizeUpdate(raw, now) {
   const pick = (v) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : null;
   };
   return {
      value: raw.value == null ? null : String(raw.value),
      rotation_at: pick(raw.rotationAt ?? raw.rotation_at),
      expires_at: pick(raw.expiresAt ?? raw.expires_at),
      created_at: now,
    };
}

// Goal 7: a session is expired when it has gone quiet for SESSION_TTL_MS.
export function sessionStatus(lastUploadAt, now = Date.now()) {
   if (lastUploadAt == null) return 'waiting';
   if (now - lastUploadAt > SESSION_TTL_MS) return 'expired';
   return 'active';
}

// A consumer view: latest update + computed status + timing.
export function toConsumerView(uuid, latest, lastUploadAt, now = Date.now()) {
   const status = sessionStatus(lastUploadAt, now);
   const created = latest ? latest.created_at : null;
   const nextExpiry = status === 'active' && lastUploadAt != null ? lastUploadAt + SESSION_TTL_MS : null;
   return {
      uuid,
      status,
      ttlMs: SESSION_TTL_MS,
      now,
      nextExpiry,
      lastUploadAt,
      createdAt: created,
      update: latest
          ? {
            id: latest.id,
            value: latest.value,
            rotationAt: latest.rotation_at ?? null,
            expiresAt: latest.expires_at ?? null,
            at: latest.created_at,
            }
          : null,
    };
}
