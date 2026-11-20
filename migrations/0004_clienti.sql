-- Date pe client venite din exportul de clienți eKIWI (nu din cel de dosare).
-- Din CNP se păstrează doar data nașterii; CNP-ul nu ajunge pe server.
-- Separat de `dosare`, ca un import nou de dosare să nu le șteargă.
CREATE TABLE clienti (
  client_id    INTEGER PRIMARY KEY,           -- ID client din eKIWI = dosare.client_id
  data_nastere TEXT,                          -- AAAA-LL-ZZ
  updated_at   TEXT NOT NULL,
  updated_by   TEXT
);
