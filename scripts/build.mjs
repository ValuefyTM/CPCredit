// Construiește interfața în ./public din sursele din ./web. Fără dependențe externe.
//   public/index.html  - pagina
//   public/app.css     - stilurile comune + stilurile fiecărui ecran
//   public/app.js      - date derivate, cititor xlsx, ecrane, motor
// Rulează singur la `wrangler dev` și `wrangler deploy` (vezi "build" în wrangler.jsonc).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const OUT = join(ROOT, 'public');
const read = (...p) => readFileSync(join(...p), 'utf8');

const VOID = new Set(['input', 'img', 'br', 'hr']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: String.fromCharCode(160) };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
});

// Șablonul unui ecran -> arbore { t: tag, a: atribute, c: copii } | text.
// Marcajul din șabloane e scris regulat: taguri închise, atribute între ghilimele duble.
function parseTemplate(html, file) {
  const rootNodes = [];
  const stack = [{ t: '#root', c: rootNodes }];
  const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>/g;
  const ATTR = /([\w:-]+)(?:\s*=\s*"([^"]*)")?/g;
  let last = 0, m;
  const text = (raw) => {
    const t = decode(raw.replace(/\s*\n\s*/g, ' '));
    if (t.trim() !== '') stack[stack.length - 1].c.push(t);
  };
  while ((m = TAG.exec(html))) {
    if (m.index > last) text(html.slice(last, m.index));
    last = TAG.lastIndex;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      if (VOID.has(tag)) continue;
      const top = stack.pop();
      if (!top || top.t !== tag) throw new Error(`${file}: </${tag}> nu închide <${top ? top.t : '?'}>`);
      continue;
    }
    const a = {};
    let am;
    ATTR.lastIndex = 0;
    while ((am = ATTR.exec(m[3]))) a[am[1].toLowerCase()] = am[2] === undefined ? '' : decode(am[2]);
    const node = { t: tag, a, c: [] };
    stack[stack.length - 1].c.push(node);
    if (!m[4] && !VOID.has(tag)) stack.push(node);
  }
  if (last < html.length) text(html.slice(last));
  if (stack.length !== 1) throw new Error(`${file}: tag neînchis <${stack[stack.length - 1].t}>`);
  if (/<[a-zA-Z/]/.test(rootNodes.filter((n) => typeof n === 'string').join(''))) throw new Error(`${file}: marcaj pe care nu l-am putut citi`);
  return rootNodes;
}

const section = (src, tag, file) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*)</${tag}>`).exec(src);
  if (!m) throw new Error(`${file}: lipsește <${tag}>`);
  return m[1];
};

// Stilurile unui ecran se aplică doar cât acel ecran e afișat.
const scopeCss = (css, name) => css.replace(/([^{}]+)\{([^{}]*)\}/g, (_, sel, decl) =>
  sel.trim().split(',').map((s) => `#app[data-s="${name}"] ${s.trim()}`).join(',') + `{${decl.trim()}}\n`);

// Separatoarele de linie Unicode (U+2028, U+2029) nu au voie să apară brut într-un script.
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');

const screens = readdirSync(join(WEB, 'screens')).filter((f) => f.endsWith('.html')).sort();
let css = read(WEB, 'app.css');
let registry = 'const __screens = {};\n';
for (const f of screens) {
  const name = f.replace(/\.html$/, '');
  const src = read(WEB, 'screens', f);
  const title = (/<!--\s*title:\s*(.+?)\s*-->/.exec(src) || [])[1] || name;
  const style = /<style>([\s\S]*?)<\/style>/.exec(src);
  if (style && style[1].trim()) css += `\n/* ${name} */\n` + scopeCss(style[1], name);
  const tpl = parseTemplate(section(src, 'template', f).replace(/<!--[\s\S]*?-->/g, ''), f);
  const code = section(src, 'script', f);
  if (!/class Component extends DCLogic/.test(code)) throw new Error(`${f}: lipsește "class Component extends DCLogic"`);
  registry += `__screens[${JSON.stringify(name)}] = { title: ${JSON.stringify(title)}, tpl: ${safeJson(tpl)}, make() {\n${code}\nreturn Component;\n} };\n`;
}

const js = `(function () {\n'use strict';\n${read(WEB, 'derive.js')}\n${read(WEB, 'xlsx-lite.js')}\n${registry}\n${read(WEB, 'runtime.js')}\n})();\n`;
const build = createHash('sha256').update(js).update(css).digest('hex').slice(0, 10);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'app.js'), js);
writeFileSync(join(OUT, 'app.css'), css);
writeFileSync(join(OUT, 'index.html'), read(WEB, 'index.html').replaceAll('__BUILD__', build));
copyFileSync(join(WEB, 'favicon.png'), join(OUT, 'favicon.png'));
console.log(`Interfață construită: ${screens.length} ecrane, app.js ${(js.length / 1024).toFixed(0)} KB, versiune ${build}`);
