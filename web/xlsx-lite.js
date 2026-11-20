// Cititor minimal de fișiere .xlsx, fără biblioteci externe.
// Citește valorile celulelor (text și numere) din foile unui registru Excel.
// XLSXLITE.read(arrayBuffer) -> Promise<{ nume foaie: [[celule rând 1], [celule rând 2], ...] }>

const XLSXLITE = (function () {
  'use strict';

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Deschide arhiva ZIP și întoarce o funcție care citește un fișier din ea ca text.
  function zip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Fișierul nu este un .xlsx valid.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = {};
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Arhivă .xlsx deteriorată.');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      entries[dec.decode(u8.subarray(p + 46, p + 46 + nlen))] = { method, csize, off };
      p += 46 + nlen + xlen + clen;
    }
    return async function text(name) {
      const e = entries[name];
      if (!e) return null;
      const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
      const raw = u8.subarray(start, start + e.csize);
      if (e.method === 0) return dec.decode(raw);
      if (e.method === 8) return dec.decode(await inflate(raw));
      throw new Error('Compresie necunoscută în fișierul .xlsx.');
    };
  }

  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const kids = (el, name) => Array.prototype.filter.call(el.children, (c) => c.localName === name);

  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  const siText = (si) => Array.prototype.map.call(si.getElementsByTagNameNS('*', 't'), (t) => t.textContent).join('');

  async function read(buf) {
    const file = zip(buf);
    const wbText = await file('xl/workbook.xml');
    const relText = await file('xl/_rels/workbook.xml.rels');
    if (!wbText || !relText) throw new Error('Fișierul nu este un registru Excel (.xlsx).');
    const rels = {};
    Array.prototype.forEach.call(xml(relText).getElementsByTagNameNS('*', 'Relationship'), (r) => { rels[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const ssText = await file('xl/sharedStrings.xml');
    const shared = ssText ? Array.prototype.map.call(xml(ssText).getElementsByTagNameNS('*', 'si'), siText) : [];

    const out = {};
    const sheets = xml(wbText).getElementsByTagNameNS('*', 'sheet');
    for (const sh of Array.from(sheets)) {
      const rid = sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sh.getAttribute('r:id');
      let target = rels[rid];
      if (!target) continue;
      target = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target;
      const text = await file(target);
      if (!text) continue;
      const data = [];
      const sd = xml(text).getElementsByTagNameNS('*', 'sheetData')[0];
      if (sd) {
        kids(sd, 'row').forEach((row) => {
          const cells = [];
          kids(row, 'c').forEach((c, i) => {
            const ref = c.getAttribute('r');
            const at = ref ? colIndex(ref) : i;
            const t = c.getAttribute('t');
            const v = kids(c, 'v')[0];
            let val = null;
            if (t === 'inlineStr') { const is = kids(c, 'is')[0]; val = is ? siText(is) : null; }
            else if (v) {
              const raw = v.textContent;
              if (t === 's') val = shared[+raw] === undefined ? null : shared[+raw];
              else if (t === 'str' || t === 'e') val = raw;
              else if (t === 'b') val = raw === '1';
              else val = raw === '' ? null : Number(raw);
            }
            cells[at] = val;
          });
          for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
          const r = +row.getAttribute('r');
          if (r) data[r - 1] = cells; else data.push(cells);
        });
      }
      for (let i = 0; i < data.length; i++) if (!data[i]) data[i] = [];
      out[sh.getAttribute('name')] = data;
    }
    return out;
  }

  // Număr de serie Excel -> "AAAA-LL-ZZ". Acceptă și text de forma AAAA-LL-ZZ sau ZZ.LL.AAAA.
  function toIsoDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') {
      if (v < 1 || v > 100000) return null;
      return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(s);
    if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    return null;
  }

  return { read, toIsoDate };
})();
