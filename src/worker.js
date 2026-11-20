// CP CRM: Worker-ul Cloudflare.
// Servește API-ul de sub /api/*; fișierele statice din ./public le servește Cloudflare direct.
//
// Legături (wrangler.jsonc):
//   DB    - baza de date D1 (dosare, stare salvată, evidența fișierelor)
//   FILES - bucketul R2 cu fișierele încărcate pe dosare
//
// Autentificare: Cloudflare Access. Fiecare cerere către /api trebuie să aibă un JWT valid
// emis de Access; fără ACCESS_TEAM_DOMAIN și ACCESS_AUD configurate, API-ul refuză tot.

const MAX_FILE = 25 * 1024 * 1024;
const MAX_STATE = 1024 * 1024;
const COLS = ['id', 'client_id', 'nume', 'banca', 'tip_credit', 'destinatie', 'tip_finantare', 'tip_dobanda', 'ani_fixa', 'produs',
  'rata_dobanda', 'suma_depusa', 'valuta', 'suma_trasa', 'data_dep', 'data_tras', 'status', 'email', 'telefon', 'data_nastere'];

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (status, error, extra) => json({ error, ...extra }, status);

// ---------- Autentificare (Cloudflare Access) ----------

let certs = { team: '', at: 0, keys: [] };

function b64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function accessKeys(team, force) {
  if (!force && certs.team === team && Date.now() - certs.at < 3600e3) return certs.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('Nu pot citi cheile Cloudflare Access');
  const body = await r.json();
  certs = { team, at: Date.now(), keys: body.keys || [] };
  return certs.keys;
}

async function verifyAccess(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const dec = new TextDecoder();
  let header, payload;
  try {
    header = JSON.parse(dec.decode(b64url(parts[0])));
    payload = JSON.parse(dec.decode(b64url(parts[1])));
  } catch (e) { return null; }
  if (header.alg !== 'RS256') return null;
  const team = env.ACCESS_TEAM_DOMAIN;
  let jwk = (await accessKeys(team, false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await accessKeys(team, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  if (payload.iss !== `https://${team}`) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (!payload.email) return null;
  return { email: String(payload.email).toLowerCase() };
}

async function authenticate(request, env) {
  // Doar pentru rulare locală (.dev.vars). Nu se setează niciodată în producție.
  if (env.AUTH_MODE === 'none') return { user: { email: 'local@dev' } };
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return { error: fail(503, 'Autentificarea nu este configurată. Setează ACCESS_TEAM_DOMAIN și ACCESS_AUD (vezi README).') };
  }
  let user = null;
  try { user = await verifyAccess(request, env); } catch (e) { return { error: fail(503, 'Nu pot verifica autentificarea Cloudflare Access.') }; }
  if (!user) return { error: fail(401, 'Neautentificat.') };
  const allowed = (env.ALLOWED_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(user.email)) return { error: fail(403, 'Contul nu are acces la această platformă.') };
  return { user };
}

// ---------- Utilitare ----------

const nowIso = () => new Date().toISOString();

async function body(request, limit) {
  const text = await request.text();
  if (text.length > limit) throw Object.assign(new Error('Cerere prea mare'), { status: 413 });
  try { return JSON.parse(text); } catch (e) { throw Object.assign(new Error('JSON invalid'), { status: 400 }); }
}

const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const text = (v, max = 300) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ---------- Dosare și import ----------

async function getDosare(env) {
  const rows = await env.DB.prepare(`SELECT ${COLS.join(', ')} FROM dosare ORDER BY data_dep DESC, id DESC`).raw();
  const last = await env.DB.prepare('SELECT file_name, total, finished_at FROM imports WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1').first();
  return json({ cols: COLS, rows, meta: { count: rows.length, importedAt: last ? last.finished_at : null, fileName: last ? last.file_name : null } });
}

async function importStart(request, env, user) {
  const b = await body(request, 10_000);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO imports (id, file_name, total, started_at, by_email) VALUES (?, ?, ?, ?, ?)')
    .bind(id, text(b.fileName, 200), Math.max(0, Math.floor(num(b.total))), nowIso(), user.email).run();
  return json({ importId: id });
}

async function importChunk(request, env) {
  const b = await body(request, 2_000_000);
  const imp = await env.DB.prepare('SELECT id FROM imports WHERE id = ? AND finished_at IS NULL').bind(String(b.importId || '')).first();
  if (!imp) return fail(400, 'Import necunoscut sau deja încheiat.');
  if (!Array.isArray(b.rows) || b.rows.length === 0 || b.rows.length > 500) return fail(400, 'Lot invalid.');
  const sql = `INSERT OR REPLACE INTO dosare (${COLS.join(', ')}, import_id) VALUES (${COLS.map(() => '?').join(', ')}, ?)`;
  const stmts = [];
  for (const r of b.rows) {
    const id = Math.floor(num(r.id)), clientId = Math.floor(num(r.client_id));
    if (!id || !clientId || !r.nume) return fail(400, 'Rând fără ID_DOSAR, ID_CLIENT sau NUME_CLIENT.', { row: r.id });
    stmts.push(env.DB.prepare(sql).bind(
      id, clientId, text(r.nume), text(r.banca), text(r.tip_credit), text(r.destinatie), text(r.tip_finantare), text(r.tip_dobanda),
      Math.floor(num(r.ani_fixa)), text(r.produs, 500), num(r.rata_dobanda), num(r.suma_depusa), text(r.valuta, 10), num(r.suma_trasa),
      isoDate(r.data_dep), isoDate(r.data_tras), text(r.status), text(r.email), text(r.telefon, 40), isoDate(r.data_nastere), imp.id,
    ));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, rows: stmts.length });
}

async function importFinish(request, env) {
  const b = await body(request, 10_000);
  const imp = await env.DB.prepare('SELECT id FROM imports WHERE id = ? AND finished_at IS NULL').bind(String(b.importId || '')).first();
  if (!imp) return fail(400, 'Import necunoscut sau deja încheiat.');
  const got = await env.DB.prepare('SELECT COUNT(*) AS n FROM dosare WHERE import_id = ?').bind(imp.id).first();
  if (!got.n) return fail(400, 'Importul nu conține niciun dosar.');
  // Exportul eKIWI este sursa de adevăr: dosarele care nu mai apar în el se șterg.
  const res = await env.DB.batch([
    env.DB.prepare('DELETE FROM dosare WHERE import_id != ?').bind(imp.id),
    env.DB.prepare('UPDATE imports SET finished_at = ?, total = ? WHERE id = ?').bind(nowIso(), got.n, imp.id),
  ]);
  return json({ ok: true, total: got.n, removed: res[0].meta.changes });
}

// ---------- Stare salvată ----------

async function getState(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM state').all();
  const out = {};
  for (const r of results) { try { out[r.key] = JSON.parse(r.value); } catch (e) { /* rând corupt: îl sar */ } }
  return json(out);
}

async function putState(request, env, user, key) {
  if (!/^[a-z]+\.[A-Za-z]+$/.test(key)) return fail(400, 'Cheie invalidă.');
  const raw = await request.text();
  if (raw.length > MAX_STATE) return fail(413, 'Prea multe date pentru o singură cheie.');
  try { JSON.parse(raw); } catch (e) { return fail(400, 'JSON invalid.'); }
  await env.DB.prepare('INSERT INTO state (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .bind(key, raw, nowIso(), user.email).run();
  return json({ ok: true });
}

// ---------- Fișiere (R2) ----------

async function listFiles(env, dosarId) {
  const { results } = await env.DB.prepare('SELECT id, doc_type, name, size, content_type, uploaded_at, uploaded_by FROM files WHERE dosar_id = ? ORDER BY uploaded_at DESC').bind(dosarId).all();
  return json({ files: results });
}

async function uploadFile(request, env, user, dosarId) {
  const dosar = await env.DB.prepare('SELECT id FROM dosare WHERE id = ?').bind(dosarId).first();
  if (!dosar) return fail(404, 'Dosar inexistent.');
  let name = '';
  try { name = decodeURIComponent(request.headers.get('X-File-Name') || ''); } catch (e) { name = ''; }
  name = name.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200);
  if (!name) return fail(400, 'Lipsește numele fișierului.');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_FILE) return fail(413, 'Fișierul depășește 25 MB.');
  const data = await request.arrayBuffer();
  if (data.byteLength === 0) return fail(400, 'Fișier gol.');
  if (data.byteLength > MAX_FILE) return fail(413, 'Fișierul depășește 25 MB.');
  const t = request.headers.get('X-Doc-Type');
  const docType = t !== null && /^[0-4]$/.test(t) ? Number(t) : null;
  const contentType = (request.headers.get('content-type') || 'application/octet-stream').slice(0, 100);
  const id = crypto.randomUUID();
  const key = `dosare/${dosarId}/${id}`;
  await env.FILES.put(key, data, { httpMetadata: { contentType }, customMetadata: { dosar: String(dosarId), by: user.email } });
  try {
    await env.DB.prepare('INSERT INTO files (id, dosar_id, doc_type, name, size, content_type, r2_key, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, dosarId, docType, name, data.byteLength, contentType, key, nowIso(), user.email).run();
  } catch (e) {
    await env.FILES.delete(key);
    throw e;
  }
  return json({ ok: true, id });
}

async function getFile(env, id) {
  const f = await env.DB.prepare('SELECT name, content_type, r2_key FROM files WHERE id = ?').bind(id).first();
  if (!f) return fail(404, 'Fișier inexistent.');
  const obj = await env.FILES.get(f.r2_key);
  if (!obj) return fail(404, 'Fișierul lipsește din bucket.');
  // PDF-urile și imaginile se deschid în browser; restul se descarcă.
  const inline = /^(application\/pdf|image\/(png|jpeg|webp|gif))$/.test(f.content_type || '');
  return new Response(obj.body, {
    headers: {
      'content-type': inline ? f.content_type : 'application/octet-stream',
      'content-length': String(obj.size),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

async function deleteFile(env, id) {
  const f = await env.DB.prepare('SELECT r2_key FROM files WHERE id = ?').bind(id).first();
  if (!f) return fail(404, 'Fișier inexistent.');
  await env.FILES.delete(f.r2_key);
  await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ---------- Rutare ----------

async function api(request, env, url) {
  const method = request.method;
  // Cererile care modifică date trebuie să vină din aceeași origine.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (!origin || new URL(origin).host !== url.host) return fail(403, 'Origine nepermisă.');
  }
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const user = auth.user;
  const path = url.pathname;
  let m;

  if (path === '/api/me' && method === 'GET') return json({ email: user.email });
  if (path === '/api/dosare' && method === 'GET') return getDosare(env);
  if (path === '/api/import/start' && method === 'POST') return importStart(request, env, user);
  if (path === '/api/import/chunk' && method === 'POST') return importChunk(request, env);
  if (path === '/api/import/finish' && method === 'POST') return importFinish(request, env);
  if (path === '/api/state' && method === 'GET') return getState(env);
  if ((m = /^\/api\/state\/([^/]+)$/.exec(path)) && method === 'PUT') return putState(request, env, user, m[1]);
  if ((m = /^\/api\/dosare\/(\d+)\/files$/.exec(path))) {
    if (method === 'GET') return listFiles(env, Number(m[1]));
    if (method === 'POST') return uploadFile(request, env, user, Number(m[1]));
  }
  if ((m = /^\/api\/files\/([0-9a-f-]{36})$/.exec(path))) {
    if (method === 'GET') return getFile(env, m[1]);
    if (method === 'DELETE') return deleteFile(env, m[1]);
  }
  return fail(404, 'Rută inexistentă.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (e) {
        console.error(e);
        return fail(e.status || 500, e.status ? e.message : 'Eroare internă.');
      }
    }
    return env.ASSETS.fetch(request);
  },
};
