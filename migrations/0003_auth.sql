-- Autentificare proprie (fără Cloudflare Access).

-- Sesiunile deschise. În cookie stă tokenul; aici doar amprenta lui SHA-256.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_email ON sessions (email);

-- Încercările greșite de login, pe email: după 5 greșeli contul se blochează 15 minute.
CREATE TABLE login_attempts (
  email        TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);
