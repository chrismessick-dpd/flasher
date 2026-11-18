/* Who sees which firmware, the way the rest of the Signoff suite works (README, *Access*).

   - flasher_data (FL.config.repo): users.json (the People list, the engine's roster format), and
     manifest.json with the firmware of every project not shared with anyone outside. FTEs only.
   - One private repo per shared project, review-flasher-<project> (PREFIX): its own manifest.json and
     firmware/, holding only that project. The FTEs plus that project's clients and contractors.

   GitHub enforces it: an FTE is anyone whose token opens flasher_data; anyone else sees the
   review-flasher-* repos their token can list. A project moves into its own repo when someone outside
   the team is first given it, exactly as a Signoff EE board does (workspace.js share()).

   A project is a set of boards: a board's `project` (else its own id), named in the manifest's
   `projects` map (else after the board). Nothing here touches the DOM, so tests can drive it. */
(function (FL) {
  'use strict';
  var SG = window.Signoff, M = SG.model, I = FL.image;
  var PREFIX = 'review-flasher-';

  function full(repo) { return FL.config.owner + '/' + repo; }
  function dataFull() { return full(FL.config.repo); }
  function store(repoFull, ctx) {
    var p = repoFull.split('/');
    return new SG.GitHubStore({ owner: p[0], repo: p[1], branch: FL.config.branch || 'main', dataPath: '', token: ctx.token }, ctx.fetch);
  }
  // The same layout publish.py writes (2-space JSON and a newline), so its additive check still holds.
  function dump(obj) { return JSON.stringify(obj, null, 2) + '\n'; }
  function parse(bytes) { return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null; }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  // The files a manifest entry is stored in: one .bin, or (kind "units", a bridge board's image) its parts.
  // A page-made image (kind "file") or a system's file in parts: each part is read as it is (joined: its SHA-256 is the
  // whole file's), and the copy is checked by git blob SHA.
  function filesOf(f) {
    if (f.kind === 'file') {
      var paths = Array.isArray(f.paths) ? f.paths : (+f.parts ? I.partPaths(f.path, +f.parts) : [f.path]);
      return paths.map(function (p) { return { path: p, sha256: f.sha256, joined: paths.length > 1 }; });
    }
    return f.kind === 'units' && Array.isArray(f.parts) ? f.parts.map(function (x) { return { path: x.path, sha256: x.sha256 }; }) : [{ path: f.path, sha256: f.sha256 }];
  }
  function systemFilesOf(x) {
    var f = x && x.remote && x.remote.file;
    return f && f.path ? filesOf({ kind: 'file', path: f.path, parts: f.parts, sha256: f.sha256 }) : [];
  }
  // A firmware entry's project: its own (set on the page), else its board's.
  function fwProject(f, boards) { return (f && typeof f.project === 'string' && f.project) || projectOf(f.board, boards && boards[f.board]); }
  function projectOf(boardId, board) { return (board && typeof board.project === 'string' && board.project) || boardId; }

  // { id: name } for a raw manifest's projects.
  function projectsIn(m) {
    var out = {};
    Object.keys((m && m.boards) || {}).forEach(function (bid) {
      var b = m.boards[bid], pid = projectOf(bid, b);
      var named = m.projects && m.projects[pid] && m.projects[pid].name;
      out[pid] = named || out[pid] || b.name || bid;
    });
    Object.keys((m && m.projects) || {}).forEach(function (pid) { if (!out[pid] && m.projects[pid] && typeof m.projects[pid].name === 'string') out[pid] = m.projects[pid].name; });
    return out;
  }

  /* Split a raw manifest into what stays and what moves with one project: { keep, move, firmware }.
     Pure: neither input is changed. firmware: the moving entries (their files move too). */
  function split(m, pid) {
    var keep = copy(m), move = { format: 1, updated: m.updated || new Date().toISOString(), boards: {}, firmware: [] };
    var boards = Object.keys(keep.boards || {}).filter(function (bid) { return projectOf(bid, keep.boards[bid]) === pid; });
    if (m.projects && m.projects[pid]) { move.projects = {}; move.projects[pid] = copy(m.projects[pid]); delete keep.projects[pid]; }
    boards.forEach(function (bid) { move.boards[bid] = keep.boards[bid]; delete keep.boards[bid]; });
    var moving = (keep.firmware || []).filter(function (f) { return boards.indexOf(f.board) >= 0; });
    keep.firmware = (keep.firmware || []).filter(function (f) { return boards.indexOf(f.board) < 0; });
    move.firmware = moving.map(copy);
    // Its passthrough systems go with it.
    var systems = [];
    Object.keys(keep.systems || {}).forEach(function (id) {
      if (keep.systems[id] && keep.systems[id].project === pid) { (move.systems = move.systems || {})[id] = keep.systems[id]; systems.push(keep.systems[id]); delete keep.systems[id]; }
    });
    return { keep: keep, move: move, firmware: moving, systems: systems };
  }

  /* Read one repo: { full, raw (manifest or null), entries, store, roster (data repo only) }. */
  function readRepo(repoFull, ctx, withRoster) {
    var st = store(repoFull, ctx);
    return st.snapshot().then(function (snap) {
      var entries = snap.entries.filter(function (e) { return e.type === 'blob'; }).map(function (e) { return { path: e.path, sha: e.sha, size: e.size }; });
      return Promise.all([
        st.readBytes('manifest.json', entries),
        withRoster ? st.readBytes('users.json', entries) : Promise.resolve(null)
      ]).then(function (got) {
        var raw;
        try { raw = parse(got[0]); } catch (e) { var e1 = new Error(repoFull + ': manifest.json isn’t valid JSON (' + e.message + ').'); e1.code = 'bad'; throw e1; }
        var roster = null;
        if (withRoster) { try { roster = M.mergeRosters(M.emptyRoster(), parse(got[1])); } catch (e) { roster = M.emptyRoster(); } }
        return { full: repoFull, raw: raw, entries: entries, store: st, head: snap.head, roster: roster };
      });
    });
  }

  /* Everything this token may flash.
     Resolves { fte, login, roster, repos: [readRepo results], invites: [{id, repo}], errors: [text] }.
     A repo that can't be read is listed in errors and left out; the rest still load. */
  function load(ctx) {
    var acct = new SG.GitHubAccount(ctx.token, ctx.fetch), out = { fte: false, login: '', roster: M.emptyRoster(), repos: [], invites: [], errors: [] };
    return acct.user().then(function (u) {
      out.login = (u && u.login || '').toLowerCase();
      // Invitations to Flasher's repos not accepted yet: an FTE gets one for each newly shared project too.
      return acct.invitations().catch(function () { return []; });
    }).then(function (inv) {
      var mine = (FL.config.owner + '/' + PREFIX).toLowerCase();
      out.invites = inv.filter(function (i) { var r = (i.repo || '').toLowerCase(); return r.indexOf(mine) === 0 || r === dataFull().toLowerCase(); });
      return readRepo(dataFull(), ctx, true).then(function (data) {
        out.fte = true; out.roster = data.roster; out.repos.push(data);
        var shared = {};
        Object.keys(out.roster.shared || {}).forEach(function (id) { var r = M.sharedRepo(out.roster, id); if (r) shared[r] = 1; });
        return Object.keys(shared);
      }, function (e) {
        if (e.status !== 404) throw e;
        // Not an FTE: the shared repos GitHub lets this token see, and any invitations waiting.
        return acct.listRepos(FL.config.owner, PREFIX).then(function (names) { return names.map(full); });
      });
    }).then(function (repos) {
      return repos.reduce(function (chain, r) {
        return chain.then(function () {
          var waiting = out.invites.some(function (i) { return (i.repo || '').toLowerCase() === r.toLowerCase(); });
          return readRepo(r, ctx, false).then(function (got) { out.repos.push(got); }, function (e) {
            if (!waiting) out.errors.push(r + ': ' + e.message);   // an invitation waiting is offered instead
          });
        });
      }, Promise.resolve());
    }).then(function () { return out; });
  }

  /* One catalog over every repo loaded: as I.cleanManifest, plus fetch(entry), projects { id: { name, repo } },
     and each firmware entry's repo. */
  function combine(loaded) {
    var c = { boards: {}, firmware: [], systems: [], problems: [], projects: {}, head: '', updated: '', source: '' }, stores = {};
    loaded.repos.forEach(function (r) {
      if (!r.raw) return;
      var one = I.cleanManifest(r.raw);
      one.problems.forEach(function (p) { c.problems.push(r.full + ': ' + p); });
      var names = projectsIn(r.raw);
      Object.keys(one.boards).forEach(function (bid) {
        if (c.boards[bid]) { c.problems.push(r.full + ': board “' + bid + '” is also in ' + c.boards[bid].repo + '; skipped here.'); return; }
        var b = one.boards[bid]; b.repo = r.full; b.project = projectOf(bid, r.raw.boards[bid]);
        c.boards[bid] = b;
        c.projects[b.project] = { name: names[b.project] || b.name, repo: r.full };
      });
      Object.keys(names).forEach(function (pid) { if (!c.projects[pid]) c.projects[pid] = { name: names[pid], repo: r.full }; });
      one.firmware.forEach(function (f) {
        if (!(c.boards[f.board] && c.boards[f.board].repo === r.full)) return;
        f.repo = r.full; f.project = f.project || c.boards[f.board].project;
        if (!c.projects[f.project]) c.projects[f.project] = { name: f.project, repo: r.full };
        c.firmware.push(f);
      });
      (one.systems || []).forEach(function (x) {
        x.repo = r.full; x.project = x.project || '';
        if (x.project && !c.projects[x.project]) c.projects[x.project] = { name: x.project, repo: r.full };
        c.systems.push(x);
      });
      stores[r.full] = r;
      if (r.raw.updated > c.updated) c.updated = r.raw.updated;
    });
    c.head = loaded.repos.map(function (r) { return r.head; }).join(',');
    c.source = loaded.repos.length === 1 ? loaded.repos[0].full : loaded.repos.length + ' repositories';
    c.fetch = function (f) { var r = stores[f.repo]; return r.store.readVerified(f.kind === 'file' ? f.paths : f.path, f.sha256, r.entries); };
    // A saved system's own remote file (systems/<id>/<name>, maybe in parts).
    c.fetchSystemFile = function (x) { var r = stores[x.repo]; return r.store.readVerified(x.remote.file.paths, x.remote.file.sha256); };
    return c;
  }

  // ── Writing (FTEs; on a personal account, only the owner can create repos and invite) ──

  /* Save the People list: re-read users.json, merge (newer wins, key by key), write. Resolves the merged roster. */
  function saveRoster(ctx, roster, message) {
    var st = store(dataFull(), ctx);
    return st.listTree('users.json').then(function (list) {
      return st.readBytes('users.json', list);
    }).then(function (bytes) {
      var merged = M.mergeRosters(M.mergeRosters(M.emptyRoster(), parse(bytes)), roster);
      return st.putFiles([{ path: 'users.json', text: dump(merged) }], { message: message || 'Flasher: People & access' }).then(function () { return merged; });
    });
  }

  function invite(ctx, repoFull, logins, log) {
    var failed = [];
    return logins.reduce(function (chain, login) {
      return chain.then(function () {
        if (log) log('Inviting @' + login + ' to ' + repoFull + '…');
        return store(repoFull, ctx).invite(login).catch(function (e) { failed.push({ login: login, repo: repoFull, message: e.message }); });
      });
    }, Promise.resolve()).then(function () { return failed; });
  }
  function revoke(ctx, repoFull, logins, log) {
    var failed = [];
    return logins.reduce(function (chain, login) {
      return chain.then(function () {
        if (log) log('Removing @' + login + ' from ' + repoFull + '…');
        return store(repoFull, ctx).revoke(login).catch(function (e) { failed.push({ login: login, repo: repoFull, message: e.message }); });
      });
    }, Promise.resolve()).then(function () { return failed; });
  }

  // { repoFull: { login: 'yes' | 'invited' } } for the repos given.
  function accessMap(ctx, repos) {
    var out = {};
    return Promise.all(repos.map(function (r) {
      var st = store(r, ctx);
      return Promise.all([st.collaborators(), st.invitations().catch(function () { return []; })]).then(function (got) {
        var m = out[r] = {};
        got[1].forEach(function (i) { m[i.login] = 'invited'; });
        got[0].forEach(function (l) { m[l] = 'yes'; });
      }, function () { out[r] = null; });
    })).then(function () { return out; });
  }

  /* Move a project out of flasher_data into its own private repo and record it in the roster.
     Copies, checks the copy, records the move, and only then removes the originals, so a failure
     part way leaves everything readable. Resolves { repo, roster }. */
  function share(ctx, roster, pid, log) {
    log = log || function () {};
    var data = store(dataFull(), ctx), acct = new SG.GitHubAccount(ctx.token, ctx.fetch), src, parts, name, dst, dstFull;
    return readRepo(dataFull(), ctx, false).then(function (r) {
      src = r;
      if (!r.raw) throw new Error(dataFull() + ' has no manifest.json.');
      parts = split(r.raw, pid);
      if (!Object.keys(parts.move.boards).length && !parts.systems.length) throw new Error('Nothing in ' + dataFull() + ' belongs to project “' + pid + '”.');
      name = projectsIn(r.raw)[pid] || pid;
      return acct.ownerType(FL.config.owner);
    }).then(function (type) {
      var base = PREFIX + M.slugify(name).slice(0, 60);
      function attempt(n) {
        var repo = n ? base + '-' + (n + 1) : base;
        log('Creating the private repository ' + full(repo) + '…');
        return acct.createRepo(FL.config.owner, repo, type === 'Organization', 'Flasher firmware: ' + name).then(function () { return repo; }, function (e) {
          if (e.status !== 422 || n > 8) throw e;
          // Taken: adopt it if it's empty or already holds this project (a share that stopped part way).
          return readRepo(full(repo), ctx, false).then(function (there) {
            var mine = there.raw && Object.keys(projectsIn(there.raw)).indexOf(pid) >= 0;
            var empty = there.entries.every(function (x) { return x.path === 'README.md'; });
            return mine || empty ? repo : attempt(n + 1);
          }, function () { return attempt(n + 1); });
        });
      }
      return attempt(0);
    }).then(function (repo) {
      dstFull = full(repo); dst = store(dstFull, ctx);
      return acct.disableActions(FL.config.owner, repo).catch(function () { log('Couldn’t turn off GitHub Actions on ' + dstFull + '; do it in its settings.'); });
    }).then(function () {
      var all = [].concat.apply([], parts.firmware.map(filesOf).concat(parts.systems.map(systemFilesOf)));
      log('Copying ' + all.length + ' firmware file' + (all.length === 1 ? '' : 's') + '…');
      return Promise.all(all.map(function (f) {
        return (f.joined ? data.readBytes(f.path, src.entries) : data.readVerified(f.path, f.sha256, src.entries)).then(function (bytes) {
          if (!bytes) throw new Error(f.path + ' isn’t in ' + dataFull() + '.');
          return { path: f.path, bytes: bytes };
        });
      }));
    }).then(function (files) {
      files.push({ path: 'manifest.json', text: dump(parts.move) });
      function put(tries) {
        return dst.putFiles(files, { message: 'Flasher: ' + name + ' moved here from ' + dataFull() }).catch(function (e) {
          // A repository GitHub has only just made can answer 404 or 409 for a moment.
          if ((e.status === 404 || e.status === 409) && tries < 5) return new Promise(function (res) { setTimeout(res, 1200); }).then(function () { return put(tries + 1); });
          throw e;
        });
      }
      return put(0).then(function () { return files; });
    }).then(function (files) {
      log('Checking the copy…');
      return dst.listTree('').then(function (list) {
        var have = {}; list.forEach(function (e) { have[e.path] = e.sha; });
        return Promise.all(files.map(function (f) {
          return SG.github.gitBlobShaBytes(f.bytes || new TextEncoder().encode(f.text)).then(function (sha) {
            if (have[f.path] !== sha) throw new Error('The copy of ' + f.path + ' in ' + dstFull + ' doesn’t match; nothing was removed from ' + dataFull() + '.');
          });
        }));
      });
    }).then(function () {
      roster = copy(roster);
      roster.shared[pid] = M.stamp({ id: pid, repo: dstFull, name: name }, ctx.login);
      log('Recording the move in the People list…');
      return saveRoster(ctx, roster, 'Flasher: ' + name + ' is shared in ' + dstFull);
    }).then(function (merged) {
      roster = merged;
      log('Removing the originals from ' + dataFull() + '…');
      var files = [{ path: 'manifest.json', text: dump(parts.keep) }].concat([].concat.apply([], parts.firmware.map(filesOf).concat(parts.systems.map(systemFilesOf))).map(function (f) { return { path: f.path, remove: true }; }));
      return data.putFiles(files, { message: 'Flasher: ' + name + ' moved to ' + dstFull });
    }).then(function () {
      var ftes = M.liveUsers(roster).filter(function (u) { return u.role === 'fte' && u.login !== FL.config.owner.toLowerCase(); }).map(function (u) { return u.login; });
      return invite(ctx, dstFull, ftes, log);
    }).then(function (failed) { return { repo: dstFull, roster: roster, failed: failed }; });
  }

  // ── Editing manifests from the page (docs/working-projects.md) ──
  // Every write reads the head and manifest.json, changes a copy, proves that nothing but the entries it names
  // changed (the copy with them put back re-serializes to the old bytes, `updated` aside), and commits on the
  // head it read (putFiles { head }). When the repo moved on, it reads again and re-applies, up to three times.
  // Then it reads manifest.json back. FTEs only: nobody else can write these repos.
  var MAPS = ['projects', 'boards', 'systems'];
  function now() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
  function newId(prefix) { return (prefix || 'w') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function emptyManifest() { return { format: 1, updated: '', projects: {}, boards: {}, firmware: [] }; }
  // The old manifest with only the touched entries taken from the new one, in the old order (new firmware last).
  function onlyTouched(old, raw, touched) {
    var out = copy(old);
    MAPS.forEach(function (k) {
      (touched[k] || []).forEach(function (id) {
        var v = raw[k] && raw[k][id];
        if (v !== undefined) { out[k] = out[k] || {}; out[k][id] = copy(v); }
        else if (out[k]) delete out[k][id];
      });
      if (old[k] === undefined && raw[k] !== undefined && out[k] === undefined) out[k] = {};   // a map the change added, still empty
      if (old[k] === undefined && raw[k] === undefined) delete out[k];
    });
    var ids = touched.firmware || [], byId = {};
    (raw.firmware || []).forEach(function (f) { byId[f.id + '@' + f.board] = f; });
    var fw = [];
    (old.firmware || []).forEach(function (f) {
      var k = f.id + '@' + f.board;
      if (ids.indexOf(k) < 0) fw.push(f);
      else if (byId[k]) fw.push(copy(byId[k]));
    });
    var had = {}; (old.firmware || []).forEach(function (f) { had[f.id + '@' + f.board] = 1; });
    (raw.firmware || []).forEach(function (f) { var k = f.id + '@' + f.board; if (ids.indexOf(k) >= 0 && !had[k]) fw.push(copy(f)); });
    out.firmware = fw;
    out.updated = raw.updated;
    return out;
  }
  function edit(ctx, repoFull, change, opts) {
    opts = opts || {};
    var st = store(repoFull, ctx), tries = 0;
    function once() {
      tries++;
      return st.snapshot().then(function (snap) {
        var entries = snap.entries.filter(function (e) { return e.type === 'blob'; }).map(function (e) { return { path: e.path, sha: e.sha, size: e.size }; });
        return st.readBytes('manifest.json', entries).then(function (bytes) {
          var old = bytes ? parse(bytes) : emptyManifest();
          if (!old || typeof old !== 'object') throw new Error(repoFull + ': manifest.json isn’t a JSON object.');
          var raw = copy(old), plan = change(raw, { entries: entries, store: st }) || {};
          var touched = plan.touched || {};
          raw.updated = now();
          // The proof: raw is the old manifest with only the touched entries changed.
          if (dump(onlyTouched(old, raw, touched)) !== dump(raw)) throw new Error('That change touched more of manifest.json than it says. Nothing was written.');
          var text = dump(raw);
          return st.putFiles([{ path: 'manifest.json', text: text }].concat(plan.files || []), { head: snap.head, message: plan.message || 'Flasher: edit', onProgress: opts.onProgress })
            .then(function (res) {
              return st.readBytes('manifest.json').then(function (back) {
                if (!back || new TextDecoder().decode(back) !== text) throw new Error(repoFull + ': manifest.json didn’t read back as written. Sync, then check it.');
                return { repo: repoFull, manifest: raw, head: res.head, pushed: res.pushed };
              });
            });
        });
      }).catch(function (e) {
        if (e.code === 'moved' && tries < 3) { if (opts.onRetry) opts.onRetry(tries); return once(); }
        throw e;
      });
    }
    return once();
  }

  // Stored files: the bytes, split in parts over PART_BYTES (GitHubStore.splitParts), and how the entry names them.
  function storedFiles(path, bytes) {
    var parts = SG.GitHubStore.splitParts(path, bytes);
    return { files: parts || [{ path: path, bytes: bytes }], parts: parts ? parts.length : 0 };
  }
  function fileFormat(name) { var m = /[.](bin|hex|elf)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }

  /* A project's name (new or renamed). */
  function saveProject(ctx, repoFull, pid, name) {
    return edit(ctx, repoFull, function (raw) {
      raw.projects = raw.projects || {};
      raw.projects[pid] = Object.assign({}, raw.projects[pid] || {}, { name: String(name).slice(0, 80) });
      return { touched: { projects: [pid] }, message: 'Flasher: project ' + name };
    });
  }
  /* A firmware entry's name and project, stamped as edited so publish.py leaves them alone. */
  function editFirmware(ctx, repoFull, fid, board, fields) {
    return edit(ctx, repoFull, function (raw) {
      var f = (raw.firmware || []).filter(function (x) { return x.id === fid && x.board === board; })[0];
      if (!f) throw new Error('That firmware isn’t in ' + repoFull + ' any more.');
      f.edited = Object.assign({}, f.edited || {});
      if (fields.name != null) { f.name = String(fields.name).slice(0, 80); f.edited.name = true; }
      if (fields.project != null) {
        var boardProject = projectOf(board, raw.boards && raw.boards[board]);
        if (fields.project === boardProject) delete f.project; else f.project = fields.project;
        f.edited.project = true;
      }
      return { touched: { firmware: [fid + '@' + board] }, message: 'Flasher: ' + (f.name || fid) };
    });
  }
  /* A new board (Define a board): checked by the page's own manifest rules first. */
  function saveBoard(ctx, repoFull, bid, board) {
    var problems = [];
    if (!I.cleanBoard(bid, board, problems)) return Promise.reject(new Error(problems.join(' ') || 'That board isn’t complete.'));
    return edit(ctx, repoFull, function (raw) {
      raw.boards = raw.boards || {};
      if (raw.boards[bid] && !board.replace) throw new Error('There’s already a board “' + bid + '”.');
      var b = copy(board); delete b.replace;
      raw.boards[bid] = b;
      return { touched: { boards: [bid] }, message: 'Flasher: board ' + (board.name || bid) };
    });
  }
  /* An image uploaded from this computer as it is (kind "file"), for a board, in a project. */
  function uploadImage(ctx, repoFull, img, opts) {
    var fmt = fileFormat(img.name);
    if (!fmt) return Promise.reject(new Error('An image is a .bin, .hex, or .elf.'));
    var id = img.id || newId('i'), path = 'firmware/' + img.board + '/' + id + '.' + fmt, sf = storedFiles(path, img.bytes);
    return I.sha256(img.bytes).then(function (sha) {
      return edit(ctx, repoFull, function (raw) {
        if (!(raw.boards && raw.boards[img.board])) throw new Error('Board “' + img.board + '” isn’t in ' + repoFull + '.');
        var f = { id: id, board: img.board, kind: 'file', format: fmt, name: String(img.title || img.name).slice(0, 80), size: img.bytes.length, sha256: sha, path: path,
          summary: String(img.summary || '').slice(0, 400), description: String(img.description || '').slice(0, 6000), uploadedBy: String(img.by || '').slice(0, 100), published: now() };
        if (sf.parts) f.parts = sf.parts;
        if (img.project && img.project !== projectOf(img.board, raw.boards[img.board])) f.project = img.project;
        if (img.source && (img.source.repo || img.source.sha)) f.source = { repo: String(img.source.repo || '').slice(0, 100), sha: String(img.source.sha || '').slice(0, 40), path: '', dirty: !!img.source.dirty };
        raw.firmware = (raw.firmware || []).concat([f]);
        return { touched: { firmware: [id + '@' + img.board] }, files: sf.files, message: 'Flasher: image ' + f.name };
      }, opts).then(function (res) { res.id = id; return res; });
    });
  }
  /* A passthrough system (slice 1's shape), with its remote's file stored beside it when it has one. */
  function saveSystem(ctx, repoFull, sys, file, opts) {
    var id = sys.id, files = [], fileRec = null;
    var ready = Promise.resolve();
    if (file && file.bytes) {
      var path = 'systems/' + id + '/' + file.name, sf = storedFiles(path, file.bytes);
      files = sf.files;
      ready = I.sha256(file.bytes).then(function (sha) { fileRec = { name: file.name, format: fileFormat(file.name), size: file.bytes.length, sha256: sha, path: path }; if (sf.parts) fileRec.parts = sf.parts; });
    }
    return ready.then(function () {
      return edit(ctx, repoFull, function (raw) {
        raw.systems = raw.systems || {};
        var was = raw.systems[id];
        var rec = { name: String(sys.name || 'Passthrough system').slice(0, 80), project: sys.project || '', host: copy(sys.host || {}), link: copy(sys.link || {}),
          remote: { name: String((sys.remote && sys.remote.name) || '').slice(0, 80) }, updated: now(), by: String(sys.by || '').slice(0, 100) };
        rec.host.usb = (rec.host.usb || []).map(function (u) { return { vid: '0x' + (u.vid >>> 0).toString(16).padStart(4, '0'), pid: '0x' + (u.pid >>> 0).toString(16).padStart(4, '0') }; });
        if (fileRec) rec.remote.file = fileRec;
        else if (was && was.remote && was.remote.file && sys.keepFile) rec.remote.file = copy(was.remote.file);
        if (sys.remote && sys.remote.release) rec.remote.release = copy(sys.remote.release);
        var problems = [];
        if (!I.cleanSystem(id, rec, problems)) throw new Error(problems.join(' '));
        // A replaced file goes; its git history keeps it.
        if (was && was.remote && was.remote.file && was.remote.file.path && !(rec.remote.file && rec.remote.file.path === was.remote.file.path)) {
          var gone = was.remote.file.parts ? I.partPaths(was.remote.file.path, was.remote.file.parts) : [was.remote.file.path];
          gone.forEach(function (p) { files.push({ path: p, remove: true }); });
        }
        raw.systems[id] = rec;
        return { touched: { systems: [id] }, files: files, message: 'Flasher: system ' + rec.name };
      }, opts);
    });
  }
  /* Delete a firmware entry, a system, or a whole project (its projects entry, boards, firmware, and systems),
     with their files. Git history keeps them. */
  function removeEntries(ctx, repoFull, what) {
    return edit(ctx, repoFull, function (raw) {
      var touched = { projects: [], boards: [], firmware: [], systems: [] }, files = [];
      function dropFw(f) {
        touched.firmware.push(f.id + '@' + f.board);
        var c = I.cleanManifest({ format: 1, boards: copy(raw.boards || {}), firmware: [f] }).firmware[0];
        (c ? filesOf(c) : [{ path: f.path }]).forEach(function (x) { if (x.path) files.push({ path: x.path, remove: true }); });
      }
      function dropSys(id) {
        var x = raw.systems && raw.systems[id]; if (!x) return;
        touched.systems.push(id);
        if (x.remote && x.remote.file && x.remote.file.path) (x.remote.file.parts ? I.partPaths(x.remote.file.path, x.remote.file.parts) : [x.remote.file.path]).forEach(function (p) { files.push({ path: p, remove: true }); });
        delete raw.systems[id];
      }
      if (what.firmware) {
        var f = (raw.firmware || []).filter(function (x) { return x.id === what.firmware.id && x.board === what.firmware.board; })[0];
        if (!f) throw new Error('That firmware isn’t there any more.');
        dropFw(f); raw.firmware = raw.firmware.filter(function (x) { return x !== f; });
      }
      if (what.system) dropSys(what.system);
      if (what.project) {
        var pid = what.project, boards = raw.boards || {};
        var keep = [];
        (raw.firmware || []).forEach(function (x) { if (fwProject(x, boards) === pid) dropFw(x); else keep.push(x); });
        raw.firmware = keep;
        Object.keys(boards).forEach(function (bid) {
          if (projectOf(bid, boards[bid]) !== pid) return;
          if (keep.some(function (x) { return x.board === bid; })) return;   // a board another project's image still uses stays
          touched.boards.push(bid); delete boards[bid];
        });
        Object.keys(raw.systems || {}).forEach(function (id) { if (raw.systems[id].project === pid) dropSys(id); });
        if (raw.projects && raw.projects[pid]) { touched.projects.push(pid); delete raw.projects[pid]; }
      }
      return { touched: touched, files: files, message: 'Flasher: delete ' + (what.label || 'entries') };
    });
  }
  /* Move a board, with every image on it, to a project in another repo: copy the files there and add the entries,
     check each copy by git blob SHA, then remove them from the first repo. */
  function moveBoard(ctx, fromFull, toFull, bid, pid, log) {
    log = log || function () {};
    var src = store(fromFull, ctx), raw0, moving = [], files = [];
    return src.snapshot().then(function (snap) {
      var entries = snap.entries.filter(function (e) { return e.type === 'blob'; }).map(function (e) { return { path: e.path, sha: e.sha, size: e.size }; });
      return src.readBytes('manifest.json', entries).then(function (b) {
        raw0 = parse(b);
        if (!raw0 || !raw0.boards || !raw0.boards[bid]) throw new Error('Board “' + bid + '” isn’t in ' + fromFull + '.');
        moving = (raw0.firmware || []).filter(function (f) { return f.board === bid; });
        var paths = [];
        var cm = I.cleanManifest({ format: 1, boards: copy(raw0.boards), firmware: moving.map(copy) });
        cm.firmware.forEach(function (f) { filesOf(f).forEach(function (x) { paths.push(x.path); }); });
        var bySha = {}; entries.forEach(function (e) { bySha[e.path] = e.sha; });
        log('Copying ' + paths.length + ' file' + (paths.length === 1 ? '' : 's') + ' to ' + toFull + '…');
        return paths.reduce(function (chain, p) {
          return chain.then(function () {
            if (!bySha[p]) throw new Error(p + ' isn’t in ' + fromFull + '.');
            return src.blobBytes(bySha[p]).then(function (bytes) { files.push({ path: p, bytes: bytes, sha: bySha[p] }); });
          });
        }, Promise.resolve());
      });
    }).then(function () {
      return edit(ctx, toFull, function (raw) {
        raw.boards = raw.boards || {};
        if (raw.boards[bid]) throw new Error('There’s already a board “' + bid + '” in ' + toFull + '.');
        raw.boards[bid] = Object.assign(copy(raw0.boards[bid]), { project: pid });
        raw.firmware = (raw.firmware || []).concat(moving.map(function (f) { var c = copy(f); delete c.project; return c; }));
        return { touched: { boards: [bid], firmware: moving.map(function (f) { return f.id + '@' + f.board; }) },
          files: files.map(function (f) { return { path: f.path, bytes: f.bytes }; }), message: 'Flasher: ' + bid + ' moved here from ' + fromFull };
      });
    }).then(function () {
      var dst = store(toFull, ctx);
      return dst.listTree('firmware/' + bid + '/').then(function (list) {
        var have = {}; list.forEach(function (e) { have[e.path] = e.sha; });
        files.forEach(function (f) { if (have[f.path] !== f.sha) throw new Error(f.path + ' didn’t copy whole to ' + toFull + '; ' + fromFull + ' is unchanged.'); });
      });
    }).then(function () {
      log('Removing them from ' + fromFull + '…');
      return edit(ctx, fromFull, function (raw) {
        delete raw.boards[bid];
        raw.firmware = (raw.firmware || []).filter(function (f) { return f.board !== bid; });
        return { touched: { boards: [bid], firmware: moving.map(function (f) { return f.id + '@' + f.board; }) },
          files: files.map(function (f) { return { path: f.path, remove: true }; }), message: 'Flasher: ' + bid + ' moved to ' + toFull };
      });
    });
  }

  /* What load() found, without its GitHubStore objects, so the page can keep it in the browser between
     visits (Chris, 2026-11-10: show the projects at once and update them by syncing); revive() puts the
     stores back for a token. */
  function slim(loaded) {
    return { fte: loaded.fte, login: loaded.login, roster: loaded.roster, invites: loaded.invites, errors: loaded.errors,
      repos: loaded.repos.map(function (r) { return { full: r.full, raw: r.raw, entries: r.entries, head: r.head, roster: r.roster }; }) };
  }
  function revive(kept, ctx) {
    var out = copy(kept);
    out.repos.forEach(function (r) { r.store = store(r.full, ctx); });
    return out;
  }

  FL.access = { systemFilesOf: systemFilesOf, edit: edit, onlyTouched: onlyTouched, newId: newId, fwProject: fwProject, saveProject: saveProject, editFirmware: editFirmware, saveBoard: saveBoard,
    uploadImage: uploadImage, saveSystem: saveSystem, removeEntries: removeEntries, moveBoard: moveBoard, fileFormat: fileFormat,
    PREFIX: PREFIX, full: full, dataFull: dataFull, dump: dump, filesOf: filesOf, projectOf: projectOf, projectsIn: projectsIn, split: split,
    readRepo: readRepo, load: load, combine: combine, slim: slim, revive: revive, saveRoster: saveRoster, invite: invite, revoke: revoke, accessMap: accessMap, share: share };
})(window.FL = window.FL || {});
