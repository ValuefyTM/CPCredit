-- Utilizatorii platformei. Autentificarea o face Cloudflare Access (cod pe email);
-- tabela decide cine are voie înăuntru și cu ce rol.
CREATE TABLE users (
  email      TEXT PRIMARY KEY,                 -- mereu cu litere mici
  nume       TEXT,
  rol        TEXT NOT NULL DEFAULT 'utilizator' CHECK (rol IN ('admin', 'utilizator')),
  activ      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT,
  last_seen  TEXT
);
