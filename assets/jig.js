/* Builds from Jig, the suite's online firmware editor (../jig/docs/design.md, *Flasher*).

   Jig's Flash opens ?jig=<project>/<commit> here. The build comes one of two ways:
     - handed over in this browser: Jig leaves { id: 'jig:<project>/<commit>', name, bytes, sha256, board,
       projectName, commit } in IndexedDB dovetail-handoff (the engine's Signoff.handoff, -demo in the demo),
       and Flasher takes it and removes it;
     - read from Jig's private data repo (a link opened later, or in another browser): builds/<project>/<commit>.json
       and .bin, the project's name, and boards.json for the Flasher board, with the sign-in's token.
   Either way the bytes are checked against the build record's SHA-256 before anything is shown.

   FL.jig.KEY_RE, FL.jig.take(key, demo), FL.jig.fetch(key, { token, fetch }) → { name, bytes, sha256, board,
   projectName, commit, project, key } */
(function (FL) {
  'use strict';
  var REPO = { owner: 'chrismessick-dpd', repo: 'jig_data' };
  var KEY_RE = /^([a-z0-9][a-z0-9-]{0,79})\/([0-9a-f]{7,64})$/;

  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function sha256(bytes) { return crypto.subtle.digest('SHA-256', bytes).then(hex); }
  function b64bytes(s) { var bin = atob(String(s).replace(/\s+/g, '')), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
  function fileName(projectName, commit) { return String(projectName || 'jig').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60) + '-' + String(commit).slice(0, 8) + '.bin'; }
  function mismatch() { var e = new Error('The firmware doesn’t match its build record’s SHA-256. Build it again in Jig.'); e.code = 'mismatch'; return e; }

  // The build Jig left in this browser, or null. Taken once: the entry is removed.
  function take(key, demo) {
    var H = window.Signoff && window.Signoff.handoff;
    if (!H || !KEY_RE.test(key)) return Promise.resolve(null);
    var id = 'jig:' + key;
    return H.get(id, demo).then(function (e) {
      if (!e || !e.bytes || !e.sha256) return null;
      var bytes = new Uint8Array(e.bytes);
      return sha256(bytes).then(function (h) {
        if (h !== e.sha256) throw mismatch();
        return H.remove(id, demo).catch(function () {}).then(function () {
          return { key: key, project: key.split('/')[0], commit: key.split('/')[1], name: e.name || fileName(e.projectName, key.split('/')[1]),
            bytes: bytes, sha256: h, board: e.board || '', projectName: e.projectName || '' };
        });
      });
    }).catch(function (err) { if (err && err.code === 'mismatch') throw err; return null; });
  }

  // The build read from jig_data with the sign-in's token.
  function fetch(key, opts) {
    var m = KEY_RE.exec(key || '');
    if (!m) return Promise.reject(new Error('Not a Jig build: ' + key));
    var project = m[1], commit = m[2];
    var gs = new window.Signoff.GitHubStore({ owner: opts.owner || REPO.owner, repo: REPO.repo, branch: 'main', token: opts.token }, opts.fetch);
    var shas = {};
    function bytesAt(path) { return shas[path] ? gs.api('/git/blobs/' + shas[path]).then(function (b) { return b64bytes(b.content); }) : Promise.resolve(null); }
    function json(path) { return bytesAt(path).then(function (b) { return b ? JSON.parse(new TextDecoder().decode(b)) : null; }); }
    var rec, meta = {}, boards = {};
    return gs.snapshot().then(function (snap) {
      snap.entries.forEach(function (e) { if (e.type === 'blob') shas[e.path] = e.sha; });
      return json('builds/' + project + '/' + commit + '.json');
    }, function (e) {
      throw new Error(e.status === 404 ? 'Your sign-in can’t open Jig’s data repo (' + REPO.repo + ').' : e.message || String(e));
    }).then(function (r) {
      if (!r) throw new Error('Jig has no build ' + commit.slice(0, 8) + ' of that project yet.');
      rec = r;
      if (!rec.ok) throw new Error('That build failed in Jig, so it has no firmware to flash.');
      return Promise.all([
        json('projects/' + project + '/project.json').then(function (x) { meta = x || {}; }),
        json('boards.json').then(function (x) { boards = (x && x.boards) || {}; }),
        bytesAt('builds/' + project + '/' + commit + '.bin').then(function (b) { if (!b) throw new Error('That build’s firmware file is missing.'); return b; })
      ]);
    }).then(function (all) {
      var bytes = all[2];
      return sha256(bytes).then(function (h) {
        if (rec.sha256 && h !== rec.sha256) throw mismatch();
        var jb = boards[rec.board] || {};
        return { key: key, project: project, commit: commit, name: fileName(meta.name || project, commit), bytes: bytes, sha256: h,
          board: typeof jb.flasher === 'string' ? jb.flasher : '', projectName: typeof meta.name === 'string' ? meta.name : project };
      });
    });
  }

  // Every Jig project and its newest passing build, for the sidebar's From Jig section ({ items, boards }). Build records never change
  // (named by commit), so the few fields used are kept in this browser by blob SHA and each is read once.
  var CACHE_KEY = 'flasher.v1.jigBuilds';
  function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function writeCache(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* full or blocked: read again next time */ } }
  function list(opts) {
    var gs = new window.Signoff.GitHubStore({ owner: opts.owner || REPO.owner, repo: REPO.repo, branch: 'main', token: opts.token }, opts.fetch);
    var cache = readCache(), used = {};
    function json(sha) { return gs.api('/git/blobs/' + sha).then(function (b) { return JSON.parse(new TextDecoder().decode(b64bytes(b.content))); }); }
    return gs.snapshot().then(function (snap) {
      var blobs = {}, projects = {}, builds = {};
      snap.entries.forEach(function (e) { if (e.type === 'blob') blobs[e.path] = e.sha; });
      Object.keys(blobs).forEach(function (p) {
        var m = /^projects\/([a-z0-9][a-z0-9-]*)\/project\.json$/.exec(p);
        if (m) projects[m[1]] = blobs[p];
        m = /^builds\/([a-z0-9][a-z0-9-]*)\/([0-9a-f]{7,64})\.json$/.exec(p);
        if (m && blobs['builds/' + m[1] + '/' + m[2] + '.bin']) (builds[m[1]] = builds[m[1]] || []).push({ commit: m[2], sha: blobs[p] });
      });
      var boardsP = blobs['boards.json'] ? json(blobs['boards.json']).then(function (x) { return (x && x.boards) || {}; }, function () { return {}; }) : Promise.resolve({});
      var ids = Object.keys(projects).filter(function (id) { return builds[id]; });
      return Promise.all([boardsP].concat(ids.map(function (id) {
        return Promise.all([json(projects[id]).catch(function () { return {}; })].concat(builds[id].map(function (b) {
          used[b.sha] = true;
          if (cache[b.sha]) return Promise.resolve(Object.assign({ commit: b.commit }, cache[b.sha]));
          return json(b.sha).then(function (r) {
            var keep = { ok: !!r.ok, at: typeof r.startedAt === 'string' ? r.startedAt : '', board: typeof r.board === 'string' ? r.board : '', size: r.bytes | 0 };
            cache[b.sha] = keep;
            return Object.assign({ commit: b.commit }, keep);
          }, function () { return null; });
        }))).then(function (all) {
          var meta = all[0] || {}, ok = all.slice(1).filter(function (b) { return b && b.ok; }).sort(function (x, y) { return x.at < y.at ? 1 : x.at > y.at ? -1 : 0; });
          return ok.length ? { project: id, name: typeof meta.name === 'string' ? meta.name : id, board: ok[0].board, build: ok[0] } : null;
        });
      }))).then(function (all) {
        var boards = all[0];
        Object.keys(cache).forEach(function (k) { if (!used[k]) delete cache[k]; });
        writeCache(cache);
        var items = all.slice(1).filter(Boolean).map(function (x) {
          var jb = boards[x.board] || {};
          return { key: x.project + '/' + x.build.commit, project: x.project, name: x.name, at: x.build.at, size: x.build.size,
            boardName: typeof jb.name === 'string' ? jb.name : x.board, flasher: typeof jb.flasher === 'string' ? jb.flasher : '' };
        }).sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
        // The Flasher boards Jig can build for (New editable project is offered only on those).
        var flasherBoards = Object.keys(boards).map(function (k) { return boards[k] && typeof boards[k].flasher === 'string' ? boards[k].flasher : ''; }).filter(Boolean);
        return { items: items, boards: flasherBoards };
      });
    });
  }

  FL.jig = { KEY_RE: KEY_RE, take: take, fetch: fetch, list: list, REPO: REPO, fileName: fileName };
})(window.FL = window.FL || {});
