-- CP CRM: schema inițială

-- Dosarele din exportul eKIWI, câte un rând pe dosar.
CREATE TABLE dosare (
  id            INTEGER PRIMARY KEY,          -- ID_DOSAR
  client_id     INTEGER NOT NULL,             -- ID_CLIENT
  nume          TEXT NOT NULL,                -- NUME_CLIENT
  banca         TEXT,
  tip_credit    TEXT,
  destinatie    TEXT,
  tip_finantare TEXT,
  tip_dobanda   TEXT,
  ani_fixa      INTEGER NOT NULL DEFAULT 0,
  produs        TEXT,
  rata_dobanda  REAL NOT NULL DEFAULT 0,
  suma_depusa   REAL NOT NULL DEFAULT 0,
  valuta        TEXT,
  suma_trasa    REAL NOT NULL DEFAULT 0,
  data_dep      TEXT,                         -- AAAA-LL-ZZ
  data_tras     TEXT,                         -- AAAA-LL-ZZ
  status        TEXT,                         -- STATUS_FINAL
  email         TEXT,
  telefon       TEXT,
  data_nastere  TEXT,                         -- AAAA-LL-ZZ, opțional
  import_id     TEXT NOT NULL
);
CREATE INDEX dosare_client ON dosare (client_id);
CREATE INDEX dosare_import ON dosare (import_id);

-- Istoricul importurilor.
CREATE TABLE imports (
  id          TEXT PRIMARY KEY,
  file_name   TEXT,
  total       INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  by_email    TEXT
);

-- Ce introduce brokerul în platformă: stadii, notițe, ipoteze, oferte.
-- Câte un document JSON pe cheie (de exemplu „radar.statuses”).
CREATE TABLE state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- Evidența fișierelor; conținutul stă în bucketul R2.
CREATE TABLE files (
  id           TEXT PRIMARY KEY,
  dosar_id     INTEGER NOT NULL,
  doc_type     INTEGER,                       -- 0..4 din lista de documente, NULL = alt document
  name         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT,
  r2_key       TEXT NOT NULL,
  uploaded_at  TEXT NOT NULL,
  uploaded_by  TEXT
);
CREATE INDEX files_dosar ON files (dosar_id);
