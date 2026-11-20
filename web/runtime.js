// Motorul interfeței: încarcă datele, desenează ecranele din șabloane și salvează ce modifică brokerul.
//
// Un ecran (web/screens/*.html) are un <template> cu marcaje și o clasă `Component extends DCLogic`:
//   {{ cale }}            - valoare din ce întoarce renderVals()
//   <sc-for list as>      - repetă conținutul pentru fiecare element
//   <sc-if value>         - afișează conținutul doar dacă valoarea e adevărată
//   onClick / onChange    - funcții întoarse de renderVals()
// `Component.persist = { camp: 'cheie.salvata' }` leagă un câmp din state de baza de date:
// se încarcă la pornire și se salvează singur la fiecare modificare.

/* global derive, __screens */
'use strict';

// ---------- API ----------

async function request(method, url, body, headers) {
  const opts = { method, headers: Object.assign({}, headers) };
  if (body !== undefined) {
    if (body instanceof Blob) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  }
  const r = await fetch(url, opts);
  if (!r.ok) {
    const err = new Error('HTTP ' + r.status);
    err.status = r.status;
    try { err.info = await r.json(); } catch (e) { /* fără corp JSON */ }
    throw err;
  }
  return r.json();
}

const API = {
  get: (url) => request('GET', url),
  send: (method, url, body) => request(method, url, body),
  upload: (dosarId, file, docType) => request('POST', '/api/dosare/' + dosarId + '/files', file, {
    'content-type': file.type || 'application/octet-stream',
    'x-file-name': encodeURIComponent(file.name),
    'x-doc-type': docType === '' || docType === null || docType === undefined ? '' : String(docType),
  }),
};

// ---------- Date ----------

const DATA = {
  _p: null, meta: null, count: 0,
  all() {
    if (!this._p) {
      this._p = API.get('/api/dosare').then((r) => {
        const d = derive(r, new Date());
        this.meta = r.meta; this.count = d.count;
        return d;
      });
    }
    return this._p;
  },
  load(name) { return this.all().then((d) => d[name]); },
  reset() { this._p = null; },
};

// Utilizatorul autentificat: { email, nume, rol }.
let ME = { email: '', nume: '', rol: '' };

// ---------- Salvare ----------

let saved = {};
const SAVE = { timers: {}, pending: 0, failed: false };

function saveLabel() {
  const el = document.getElementById('save-state');
  if (!el) return;
  el.textContent = SAVE.failed ? 'Nu am putut salva ultima modificare' : (SAVE.pending ? 'Se salvează…' : 'Toate modificările sunt salvate');
  el.style.color = SAVE.failed ? '#FF8A4C' : '';
}

function queueSave(key, value) {
  saved[key] = value;
  if (SAVE.timers[key]) clearTimeout(SAVE.timers[key]); else SAVE.pending++;
  saveLabel();
  SAVE.timers[key] = setTimeout(() => {
    delete SAVE.timers[key];
    API.send('PUT', '/api/state/' + key, saved[key])
      .then(() => { SAVE.failed = false; })
      .catch(() => { SAVE.failed = true; })
      .then(() => { SAVE.pending--; saveLabel(); });
  }, 500);
}

window.addEventListener('beforeunload', (e) => { if (SAVE.pending) { e.preventDefault(); e.returnValue = ''; } });

// ---------- Componente ----------

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  Promise.resolve().then(() => { scheduled = false; render(); });
}

class DCLogic {
  constructor(props) { this.props = props || {}; this.state = {}; }
  setState(p) {
    const patch = typeof p === 'function' ? p(this.state, this.props) : p;
    const prev = this.state;
    this.state = Object.assign({}, prev, patch);
    const map = this.constructor.persist;
    if (map) Object.keys(map).forEach((k) => { if (prev[k] !== this.state[k]) queueSave(map[k], this.state[k]); });
    schedule();
  }
  forceUpdate() { schedule(); }
}

if (!navigator.clipboard) {
  try {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText(t) {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) { /* nimic de făcut */ }
      ta.remove();
      return Promise.resolve();
    } } });
  } catch (e) { /* nimic de făcut */ }
}

// ---------- Desenare ----------

const SVGNS = 'http://www.w3.org/2000/svg';
const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g, WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

function look(path, sc) {
  if (path === 'true') return true;
  if (path === 'false') return false;
  if (path === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(path)) return +path;
  let v = sc;
  const ks = path.split('.');
  for (let i = 0; i < ks.length; i++) { if (v === null || v === undefined) return undefined; v = v[ks[i]]; }
  return v;
}
const fill = (str, sc) => str.replace(HOLE, (_, p) => { const v = look(p, sc); return v === null || v === undefined ? '' : String(v); });
function val(str, sc) {
  const m = WHOLE.exec(str);
  if (m) return look(m[1], sc);
  return str.indexOf('{{') < 0 ? str : fill(str, sc);
}

function build(node, sc, parent, svg) {
  if (typeof node === 'string') { parent.appendChild(document.createTextNode(fill(node, sc))); return; }
  const tag = node.t, a = node.a || {}, c = node.c || [];
  if (tag === 'sc-for') {
    const list = val(a.list, sc) || [], as = a.as || 'item';
    list.forEach((it, i) => { const s = Object.create(sc); s[as] = it; s.$index = i; c.forEach((ch) => build(ch, s, parent, svg)); });
    return;
  }
  if (tag === 'sc-if') { if (val(a.value, sc)) c.forEach((ch) => build(ch, sc, parent, svg)); return; }
  const isSvg = svg || tag === 'svg';
  const el = isSvg ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
  let pv, hasV = false, pc, hasC = false;
  Object.keys(a).forEach((k) => {
    if (k.indexOf('hint-') === 0) return;
    const v = val(a[k], sc);
    if (k.indexOf('on') === 0) {
      if (typeof v !== 'function') return;
      let ev = k.slice(2);
      // onChange pe câmpuri de text înseamnă „la fiecare tastă”, ca în React.
      if (ev === 'change' && !(tag === 'select' || a.type === 'checkbox' || a.type === 'radio' || a.type === 'file')) ev = 'input';
      el.addEventListener(ev, v);
      return;
    }
    if (k === 'value' && (tag === 'input' || tag === 'select' || tag === 'textarea')) { pv = v; hasV = true; return; }
    if (k === 'checked') { pc = !!v; hasC = true; return; }
    if (v === false || v === null || v === undefined) return;
    el.setAttribute(k === 'viewbox' ? 'viewBox' : k, v === true ? '' : String(v));
  });
  c.forEach((ch) => build(ch, sc, el, isSvg));
  if (hasV) el.value = pv === null || pv === undefined ? '' : String(pv);
  if (hasC) el.checked = pc;
  parent.appendChild(el);
}

const root = document.getElementById('app');
let cur = null;
let insts = {};

function pathOf(el) {
  const p = [];
  while (el && el !== root) {
    const par = el.parentNode;
    if (!par) return null;
    p.unshift(Array.prototype.indexOf.call(par.childNodes, el));
    el = par;
  }
  return el === root ? p : null;
}
function at(path) {
  let el = root;
  for (let i = 0; path && i < path.length; i++) el = el && el.childNodes[path[i]];
  return el;
}

function render() {
  const inst = insts[cur];
  if (!inst) return;
  let frag;
  try {
    const vals = inst.renderVals();
    frag = document.createDocumentFragment();
    __screens[cur].tpl.forEach((n) => build(n, vals, frag, false));
  } catch (e) {
    console.error(e);
    showProblem('Ecranul nu a putut fi afișat', 'A apărut o eroare la afișare. Reîncarcă pagina; dacă se repetă, trimite mesajul de mai jos.', String(e && e.message));
    return;
  }
  const ae = document.activeElement;
  let keep = null;
  if (ae && root.contains(ae)) {
    keep = { id: ae.id, path: pathOf(ae), tag: ae.tagName };
    try { keep.s = ae.selectionStart; keep.e = ae.selectionEnd; } catch (e) { /* câmp fără selecție */ }
  }
  const scrolls = [];
  root.querySelectorAll('[style*="overflow-x"]').forEach((el) => { if (el.scrollLeft) scrolls.push([pathOf(el), el.scrollLeft]); });
  root.replaceChildren(frag);
  scrolls.forEach((s) => { const el = at(s[0]); if (el && el.nodeType === 1) el.scrollLeft = s[1]; });
  if (keep) {
    const el = (keep.id && document.getElementById(keep.id)) || at(keep.path);
    if (el && el.nodeType === 1 && el.tagName === keep.tag) {
      el.focus({ preventScroll: true });
      try { if (keep.s !== null && keep.s !== undefined) el.setSelectionRange(keep.s, keep.e); } catch (e) { /* câmp fără selecție */ }
    }
  }
  if (inst.componentDidUpdate) inst.componentDidUpdate();
}

function showProblem(title, text, detail) {
  root.replaceChildren();
  const box = document.createElement('main');
  box.style.cssText = 'flex:999 1 560px;min-width:0;box-sizing:border-box;padding:48px 32px;display:flex;flex-direction:column;gap:10px;max-width:720px';
  const h = document.createElement('h1'); h.className = 'hd'; h.style.cssText = 'margin:0;font-size:26px'; h.textContent = title;
  const p = document.createElement('p'); p.style.cssText = 'margin:0;line-height:1.5;color:#3D4653'; p.textContent = text;
  box.append(h, p);
  if (detail) { const d = document.createElement('pre'); d.style.cssText = 'margin:0;white-space:pre-wrap;font-size:12px;color:#5B6472'; d.textContent = detail; box.append(d); }
  root.append(box);
}

// ---------- Navigare ----------

function parseHash() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  const q = h.indexOf('?');
  const name = q < 0 ? h : h.slice(0, q);
  const params = {};
  if (q >= 0) new URLSearchParams(h.slice(q + 1)).forEach((v, k) => { params[k] = v; });
  return { name: name || 'Main', params };
}

function markNav(name) {
  document.querySelectorAll('#nav a[data-nav]').forEach((a) => {
    const on = a.getAttribute('data-nav') === name;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

function go() {
  let { name, params } = parseHash();
  if (!__screens[name]) name = 'Main';
  if (name === 'Utilizatori' && ME.rol !== 'admin') name = 'Main';
  // Fără date nu are ce afișa niciun ecran: trimite la import.
  if (!DATA.count && name !== 'Import' && name !== 'Utilizatori') { name = 'Import'; params = {}; }
  const changed = name !== cur;
  cur = name;
  root.setAttribute('data-s', name);
  document.title = __screens[name].title + ' · CP CRM';
  markNav(name);
  let inst = insts[name];
  if (!inst) {
    const C = __screens[name].make();
    inst = insts[name] = new C({});
    const map = C.persist;
    if (map) Object.keys(map).forEach((k) => { if (saved[map[k]] !== undefined) inst.state[k] = saved[map[k]]; });
    render();
    if (inst.componentDidMount) inst.componentDidMount();
  } else {
    render();
  }
  if (inst.onRoute && Object.keys(params).length) inst.onRoute(params);
  if (changed) window.scrollTo(0, 0);
}

function sidebar() {
  const m = DATA.meta || {};
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  const when = m.importedAt ? new Date(m.importedAt).toLocaleDateString('ro-RO') : 'niciun import';
  set('meta-import', 'Ultimul import: ' + when);
  set('meta-count', (m.count || 0).toLocaleString('ro-RO') + ' dosare');
  DATA.load('core').then((c) => {
    const b = document.getElementById('nav-radar');
    if (b) { b.textContent = c.radar.urgent.n; b.hidden = !c.radar.urgent.n; }
  }).catch(() => { /* fără date */ });
}

const APP = {
  // După un import: datele se recitesc și ecranele se reconstruiesc.
  async reload(target) {
    DATA.reset();
    await DATA.all();
    insts = {}; cur = null;
    sidebar();
    if (location.hash !== '#' + target) location.hash = target; else go();
  },
};

document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (a && a.getAttribute('href') === '#') e.preventDefault();
});
window.addEventListener('hashchange', go);

(async function boot() {
  try {
    const [me, state] = await Promise.all([API.get('/api/me'), API.get('/api/state'), DATA.all()]);
    saved = state || {};
    ME = me;
    const who = document.getElementById('meta-user');
    if (who) who.textContent = me.nume ? me.nume + ' · ' + me.email : me.email;
    const nu = document.getElementById('nav-users');
    if (nu) nu.hidden = me.rol !== 'admin';
    sidebar();
    saveLabel();
    go();
  } catch (e) {
    console.error(e);
    const info = e.info && e.info.error;
    if (e.status === 401) showProblem('Nu ești autentificat', 'Sesiunea Cloudflare Access a expirat sau lipsește. Reîncarcă pagina ca să te autentifici din nou.', info);
    else if (e.status === 403) showProblem('Acces refuzat', 'Contul cu care ești autentificat nu are acces la această platformă.', info);
    else if (e.status === 503) showProblem('Platforma nu este configurată complet', 'Autentificarea Cloudflare Access nu este încă setată pe acest Worker.', info);
    else showProblem('Nu pot încărca datele', 'Serverul nu a răspuns cum trebuie. Reîncarcă pagina peste câteva momente.', info || String(e && e.message));
  }
})();
