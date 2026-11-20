# CP CRM

Platformă pentru broker de credite: dosare, clienți, radar de refinanțare, simulator și rapoarte, pe datele exportate din eKIWI.

Rulează pe Cloudflare: un Worker (API + interfață), o bază de date D1 pentru dosare și ce introduce brokerul, și un bucket R2 separat pentru fișierele încărcate pe dosare.

> **Stadiu:** prima versiune. Testată local cu `wrangler dev`: importul exportului eKIWI, toate ecranele, salvarea după reîncărcare și fișierele pe dosar. Verificarea Cloudflare Access a fost testată doar cu chei generate local. Platforma nu a fost încă instalată în Cloudflare.

## Structură

| Cale | Ce conține |
|---|---|
| `src/worker.js` | API-ul de sub `/api/*` și verificarea Cloudflare Access |
| `migrations/` | Schema bazei de date D1 |
| `web/screens/*.html` | Ecranele: șablon + logica fiecăruia |
| `web/runtime.js` | Motorul interfeței: desenare, navigare, salvare |
| `web/derive.js` | Calculele făcute în browser din lista de dosare |
| `web/xlsx-lite.js` | Cititorul de fișiere Excel folosit la import |
| `scripts/build.mjs` | Construiește `public/` din `web/` (fără dependențe) |
| `wrangler.jsonc` | Configurarea Worker-ului, a D1 și a R2 |

Datele clienților nu se păstrează în repo. Ele ajung în D1 prin ecranul **Import date**, din exportul Excel eKIWI.

## Rulare locală

```bash
npm install
cp .dev.vars.example .dev.vars      # oprește autentificarea, doar local
npm run db:migrate:local
npm run dev                         # http://localhost:8787
```

Local, D1 și R2 sunt simulate pe disc, în `.wrangler/`.

## Instalare în Cloudflare

1. **Baza de date:** `npx wrangler d1 create cpcredit`, apoi pune `database_id` primit în `wrangler.jsonc`.
2. **Bucketul de fișiere:** `npx wrangler r2 bucket create cpcredit-files`.
3. **Schema:** `npm run db:migrate`.
4. **Publicare:** `npm run deploy`.
5. **Autentificare:** în Cloudflare Zero Trust, creează o aplicație Access de tip *Self-hosted* pe adresa Worker-ului și o politică ce permite doar adresele de email dorite. Copiază în `wrangler.jsonc`:
   - `ACCESS_TEAM_DOMAIN`: domeniul echipei, de forma `nume.cloudflareaccess.com`;
   - `ACCESS_AUD`: valoarea *Application Audience (AUD)* a aplicației.

   Apoi publică din nou. Până când aceste două valori sunt setate, API-ul refuză orice cerere.
6. **Date:** deschide platforma, mergi la **Import date** și încarcă exportul eKIWI.

## Import

Platforma citește foaia `eKIWI` din fișierul `.xlsx`, după numele coloanelor din primul rând. Lista coloanelor și care sunt obligatorii apare în ecranul de import.

Importul înlocuiește lista de dosare: cele care nu mai apar în fișier se șterg. Notițele, stadiile, ipotezele și fișierele încărcate rămân.

## Ce se salvează

Tot ce introduce brokerul se păstrează în tabela `state`, câte un document pe cheie:

| Cheie | Conținut |
|---|---|
| `radar.set`, `radar.ov`, `radar.statuses`, `radar.scen` | Ipotezele radarului, datele reale ale creditelor, stadiile discuțiilor, scenariul ales |
| `dosare.moved`, `dosare.docs`, `dosare.notes` | Etapa din pipeline, bifele de documente, notițele pe dosar |
| `clienti.items` | Notițele și sarcinile pe client |
| `oferte.off`, `oferte.ircc` | Ofertele băncilor și IRCC |
| `main.bDone` | Clienții felicitați de ziua lor |
