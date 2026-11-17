/* Register definitions for the Registers view: the bundled ST SVDs (assets/probe/svd/<NAME>.json.gz, made
   by tools/svd_to_json.py), or any .svd file opened in the page, parsed to the same shape:
   { name, cpu, p: [{ n, b, g, d, from, r: [{ n, o, s, a, r, ra, d, f: [{ n, l, w, a, d, e }] }] }] } */
(function () {
  'use strict';
  var FL = window.FL = window.FL || {};

  // A derived peripheral takes its source's registers.
  function resolve(dev) {
    var by = {};
    dev.p.forEach(function (p) { by[p.n] = p; });
    dev.p.forEach(function (p) { if (p.from && by[p.from]) { p.r = by[p.from].r; if (!p.d) p.d = by[p.from].d; if (!p.g) p.g = by[p.from].g; } if (!p.r) p.r = []; });
    return dev;
  }

  async function bundled(name) {
    var r = await fetch((FL.svd.base || 'assets/probe/svd/') + name + '.json.gz');
    if (!r.ok) throw new Error('No bundled register file for ' + name + '.');
    var text;
    if (typeof DecompressionStream !== 'undefined') text = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
    else throw new Error('This browser can\'t unpack the bundled register file.');
    return resolve(JSON.parse(text));
  }

  function num(s, d) {
    if (s == null) return d;
    s = String(s).trim().toLowerCase();
    if (!s) return d;
    if (s[0] === '#') return parseInt(s.slice(1).replace(/x/g, '0'), 2);
    if (s.indexOf('0b') === 0) return parseInt(s.slice(2), 2);
    return s.indexOf('0x') === 0 ? parseInt(s, 16) : parseInt(s, 10);
  }
  function short(s, n) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    var m = /^(.+?[.:;])(\s|$)/.exec(s); if (m) s = m[1];
    n = n || 140; return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function kid(el, tag) { for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === tag) return c; return null; }
  function txt(el, tag) { var k = kid(el, tag); return k ? k.textContent : null; }

  // Parse an SVD file's text (any vendor; secure aliases dropped).
  function parseXml(xml) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('This is not a readable SVD file.');
    var root = doc.documentElement, defSize = num(txt(root, 'size'), 32), defAcc = txt(root, 'access'), defRst = num(txt(root, 'resetValue'), 0);
    var periphs = [];
    var ps = root.getElementsByTagName('peripheral');
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i], name = txt(p, 'name');
      if (/^SEC_/.test(name)) continue;
      var e = { n: name, b: num(txt(p, 'baseAddress'), 0) };
      if (txt(p, 'groupName')) e.g = txt(p, 'groupName');
      if (p.getAttribute('derivedFrom')) e.from = p.getAttribute('derivedFrom');
      else {
        e.d = short(txt(p, 'description'));
        e.r = [];
        var rs = p.getElementsByTagName('register');
        for (var j = 0; j < rs.length; j++) {
          var r = rs[j], reg = { n: txt(r, 'name'), o: num(txt(r, 'addressOffset'), 0), f: [] };
          var size = num(txt(r, 'size'), defSize); if (size !== 32) reg.s = size;
          var acc = txt(r, 'access') || defAcc; if (acc && acc !== 'read-write') reg.a = acc;
          var rst = num(txt(r, 'resetValue'), defRst); if (rst) reg.r = rst;
          if (txt(r, 'readAction')) reg.ra = txt(r, 'readAction');
          reg.d = short(txt(r, 'description'));
          var fs = r.getElementsByTagName('field');
          for (var k = 0; k < fs.length; k++) {
            var f = fs[k], lsb = num(txt(f, 'bitOffset')), w = num(txt(f, 'bitWidth'), 1);
            if (lsb === undefined) {
              var range = txt(f, 'bitRange');
              if (range) { var hl = range.replace(/[\[\]]/g, '').split(':'); lsb = +hl[1]; w = +hl[0] - lsb + 1; }
              else { lsb = num(txt(f, 'lsb'), 0); w = num(txt(f, 'msb'), 0) - lsb + 1; }
            }
            var fe = { n: txt(f, 'name'), l: lsb, w: w };
            if (txt(f, 'access') && txt(f, 'access') !== 'read-write') fe.a = txt(f, 'access');
            if (txt(f, 'description')) fe.d = short(txt(f, 'description'));
            var evs = f.getElementsByTagName('enumeratedValue');
            if (evs.length) {
              fe.e = {};
              for (var m = 0; m < evs.length; m++) { var v = num(txt(evs[m], 'value')); if (!isNaN(v)) fe.e[v] = txt(evs[m], 'name') + (txt(evs[m], 'description') ? ': ' + short(txt(evs[m], 'description'), 60) : ''); }
            }
            reg.f.push(fe);
          }
          reg.f.sort(function (a, b) { return a.l - b.l; });
          var dim = num(txt(r, 'dim'));
          if (dim) {
            var inc = num(txt(r, 'dimIncrement'), 4), idx = (txt(r, 'dimIndex') || '').split(',');
            for (var x = 0; x < dim; x++) {
              var tag = idx.length === dim ? idx[x] : String(x);
              e.r.push(Object.assign({}, reg, { n: reg.n.replace('[%s]', tag).replace('%s', tag), o: reg.o + x * inc }));
            }
          } else e.r.push(reg);
        }
        e.r.sort(function (a, b) { return a.o - b.o; });
      }
      periphs.push(e);
    }
    periphs.sort(function (a, b) { return a.n < b.n ? -1 : 1; });
    var cpu = kid(root, 'cpu');
    return resolve({ name: txt(root, 'name'), cpu: cpu ? txt(cpu, 'name') : '', p: periphs });
  }

  function fieldValue(v, f) { return f.w >= 32 ? v >>> 0 : (v >>> f.l) & ((1 << f.w) - 1); }
  function withField(v, f, x) { if (f.w >= 32) return x >>> 0; var m = ((1 << f.w) - 1) << f.l; return ((v & ~m) | ((x << f.l) & m)) >>> 0; }
  // Reading this register changes something (a FIFO pops, a flag clears): never read it unasked.
  function sideEffects(reg) { return !!reg.ra || /^(DR|RDR|RXDR|RXFIFO|FIFO|DATA)\d*$/i.test(reg.n) || /read.*clear/i.test(reg.d || ''); }

  FL.svd = { bundled: bundled, parseXml: parseXml, resolve: resolve, fieldValue: fieldValue, withField: withField, sideEffects: sideEffects };
})();
