// Transformă dosarele primite de la API în seturile de date folosite de ecrane.
// Totul se calculează în browser, din lista completă de dosare.
//   core    - totaluri, grafice, pipeline, sumar radar (Acasă, Rapoarte, Simulator)
//   dosare  - toate dosarele, cu toate câmpurile (Dosare)
//   clients - clienții cu dosarele lor (Clienți)
//   radar   - clienții cu motiv de refinanțare (Radar)

function derive(api, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const Y = today.getFullYear();
  const DAY = 86400000;
  const col = {};
  api.cols.forEach((c, i) => { col[c] = i; });

  const pd = (iso) => (iso ? new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) : null);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const fd = (d) => (d ? p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear() : '');
  const key = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const days = (a, b) => Math.round((b - a) / DAY);
  const nm = (s) => String(s || '').trim().split(/\s+/).map((w) => w.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-')).join(' ');
  const ph = (v) => {
    let s = String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
    if (s.length < 9) return '';
    if (s.length === 9) s = '0' + s;
    return s.slice(0, 4) + ' ' + s.slice(4, 7) + ' ' + s.slice(7);
  };
  const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

  const rows = api.rows.map((a) => {
    const D = pd(a[col.data_dep]) || today;
    const T = pd(a[col.data_tras]);
    return {
      id: a[col.id], cid: a[col.client_id], n: nm(a[col.nume]), b: str(a[col.banca]), tip: str(a[col.tip_credit]), de: str(a[col.destinatie]),
      fin: str(a[col.tip_finantare]), td: str(a[col.tip_dobanda]), af: a[col.ani_fixa] || 0, prod: str(a[col.produs]),
      r: Math.round((a[col.rata_dobanda] || 0) * 100) / 100, sd: Math.round(a[col.suma_depusa] || 0), val: str(a[col.valuta]),
      tr: Math.round(a[col.suma_trasa] || 0), st: str(a[col.status]), e: str(a[col.email]).toLowerCase(), t: ph(a[col.telefon]),
      bd: a[col.data_nastere] || '', D, T, DT: T || D, y: D.getFullYear(),
    };
  }).sort((a, b) => b.D - a.D || b.id - a.id);

  const OK = 'Dosar Reconciliat';
  const CLOSED = [OK, 'Respins client', 'Dosar respins banca', 'Respins Kiwi'];
  const OPEN = { 'Nou': 'nou', 'Analiza banca': 'analiza', 'Dosar aprobat': 'aprobat', 'Dosar disbursat': 'tras' };
  const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
  const median = (v) => {
    if (!v.length) return null;
    const s = v.slice().sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const conv = (list) => {
    const c = list.filter((x) => CLOSED.includes(x.st));
    return c.length ? Math.round(1000 * c.filter((x) => x.st === OK).length / c.length) / 10 : null;
  };
  const toDraw = (list) => {
    const m = median(list.filter((x) => x.tr > 0 && x.T).map((x) => days(x.D, x.T)).filter((d) => d >= 0));
    return m === null ? null : Math.trunc(m);
  };
  const counts = (list, f) => {
    const m = new Map();
    list.forEach((x) => { const k = f(x); m.set(k, (m.get(k) || 0) + 1); });
    return Array.from(m, ([l, n]) => ({ l, n })).sort((a, b) => b.n - a.n);
  };
  const banks = (list) => {
    const m = new Map();
    list.forEach((x) => { if (!m.has(x.b)) m.set(x.b, []); m.get(x.b).push(x); });
    return Array.from(m, ([b, g]) => {
      const drawn = g.filter((x) => x.tr > 0);
      return { b, dep: g.length, trase: drawn.length, sum: sum(drawn, (x) => x.tr), conv: conv(g), days: toDraw(g) };
    }).sort((a, b) => b.sum - a.sum);
  };

  const drawn = rows.filter((x) => x.tr > 0);
  const MO = ['ian', 'feb', 'mar', 'apr', 'mai', 'iun', 'iul', 'aug', 'sep', 'oct', 'noi', 'dec'];

  // ----- radar: ultimul credit ipotecar tras al fiecărui client -----
  const lastMortgage = new Map();
  rows.filter((x) => x.tr > 0 && x.T && x.tip !== 'Nevoi personale').forEach((x) => {
    const cur = lastMortgage.get(x.cid);
    if (!cur || x.T > cur.T) lastMortgage.set(x.cid, x);
  });
  const ORDER = { urgent: 0, curand: 1, expirata: 2, variabila: 3 };
  const radar = [];
  lastMortgage.forEach((x) => {
    let ex = null, z = null, c = null;
    if (x.af > 0) {
      ex = new Date(x.T.getFullYear() + x.af, x.T.getMonth(), x.T.getDate());
      z = days(today, ex);
      c = z < 0 ? 'expirata' : (z <= 90 ? 'urgent' : (z <= 365 ? 'curand' : null));
    } else if (x.td === 'Variabila' && x.T.getFullYear() >= 2021) {
      c = 'variabila';
    }
    if (!c) return;
    radar.push({ id: x.id, cid: x.cid, n: x.n, b: x.b, s: x.tr, dt: fd(x.T), af: x.af, td: x.td, r: x.r, de: x.de, ex: fd(ex), z, c, t: x.t, e: x.e });
  });
  radar.sort((a, b) => ORDER[a.c] - ORDER[b.c] || (a.z || 0) - (b.z || 0) || b.s - a.s);
  const radarOf = new Map(radar.map((x) => [x.cid, x.c]));

  // ----- core -----
  const lastYearToday = new Date(Y - 1, today.getMonth(), today.getDate());
  const drawnY = drawn.filter((x) => x.DT.getFullYear() === Y);
  const drawnPrev = drawn.filter((x) => x.DT.getFullYear() === Y - 1 && x.DT <= lastYearToday);
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Y, today.getMonth() - i, 1);
    const same = (d) => d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth();
    const tr = drawn.filter((x) => same(x.DT));
    months.push({ l: MO[m.getMonth()], y: m.getFullYear(), trase: tr.length, sum: sum(tr, (x) => x.tr), dep: rows.filter((x) => same(x.D)).length });
  }
  const minY = rows.length ? Math.min.apply(null, rows.map((x) => x.y)) : Y;
  const years = [];
  const banksBy = { all: banks(rows) };
  for (let y = minY; y <= Y; y++) {
    const dep = rows.filter((x) => x.y === y), tr = drawn.filter((x) => x.DT.getFullYear() === y);
    years.push({ y, dep: dep.length, trase: tr.length, sum: sum(tr, (x) => x.tr), conv: conv(dep) });
    banksBy[String(y)] = banks(dep);
  }
  const imported = api.meta && api.meta.importedAt ? new Date(api.meta.importedAt) : null;

  // ----- clienți -----
  const byClient = new Map();
  rows.forEach((x) => { if (!byClient.has(x.cid)) byClient.set(x.cid, []); byClient.get(x.cid).push(x); });
  const clients = Array.from(byClient, ([cid, g]) => {
    const withMail = g.find((x) => x.e), withBd = g.find((x) => x.bd), withTel = g.find((x) => x.t);
    return {
      id: cid, n: g[0].n, t: withTel ? withTel.t : '', e: withMail ? withMail.e : '', rc: radarOf.get(cid) || '', la: String(key(g[0].D)),
      bd: withBd ? withBd.bd.slice(8, 10) + '.' + withBd.bd.slice(5, 7) + '.' + withBd.bd.slice(0, 4) : '',
      f: g.map((x) => [x.id, x.b, x.tip, x.de, x.fin, x.td, x.af, x.sd, x.tr, fd(x.D), fd(x.T), x.st]),
    };
  }).sort((a, b) => (a.la < b.la ? 1 : (a.la > b.la ? -1 : 0)));

  const core = {
    asOf: imported ? fd(imported) : '—',
    year: Y,
    tot: { dosare: rows.length, clienti: byClient.size, trase: drawn.length, sum: sum(drawn, (x) => x.tr), conv: conv(rows), days: toDraw(rows), ticket: Math.round(median(drawn.map((x) => x.tr)) || 0) },
    ytd: {
      dep: rows.filter((x) => x.y === Y).length, trase: drawnY.length, sum: sum(drawnY, (x) => x.tr),
      sumPrev: sum(drawnPrev, (x) => x.tr), trasePrev: drawnPrev.length,
      conv: conv(rows.filter((x) => x.y === Y)), convPrev: conv(rows.filter((x) => x.y === Y - 1)),
    },
    months, years, banks: banksBy,
    types: counts(drawn.filter((x) => x.tip), (x) => x.tip),
    rates: counts(drawn, (x) => x.td || 'Nenotată'),
    fin: counts(drawn, (x) => x.fin || 'Nenotat'),
    status: counts(rows, (x) => x.st),
    pipeline: rows.filter((x) => OPEN[x.st]).map((x) => ({ id: x.id, cid: x.cid, n: x.n, b: x.b, tip: x.tip, de: x.de, fin: x.fin, s: x.tr > 0 ? x.tr : x.sd, dd: fd(x.D), z: days(x.D, today), st: OPEN[x.st], t: x.t })),
    radar: {},
    radarTop: radar.filter((x) => x.c === 'urgent').slice(0, 7),
    birthdays: clients.filter((c) => c.bd).map((c) => ({ cid: c.id, n: c.n, t: c.t, bd: c.bd })),
  };
  Object.keys(ORDER).forEach((k) => { const l = radar.filter((x) => x.c === k); core.radar[k] = { n: l.length, s: sum(l, (x) => x.s) }; });

  const dosare = rows.map((x) => [x.id, x.cid, x.n, x.b, x.tip, x.de, x.fin, x.td, x.af, x.prod, x.r, x.sd, x.val, x.tr, fd(x.D), fd(x.T), x.st, x.e, x.t, key(x.D), days(x.D, today)]);

  return { count: rows.length, core, dosare, clients, radar };
}
