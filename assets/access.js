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

  function projectOf(boardId, board) { return (board && typeof board.project === 'string' && board.project) || boardId; }

  // { id: name } for a raw manifest's projects.
  function projectsIn(m) {
    var out = {};
    Object.keys((m && m.boards) || {}).forEach(function (bid) {
      var b = m.boards[bid], pid = projectOf(bid, b);
      var named = m.projects && m.projects[pid] && m.projects[pid].name;
      out[pid] = named || out[pid] || b.name || bid;
    });
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
    return { keep: keep, move: move, firmware: moving };
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
    var c = { boards: {}, firmware: [], problems: [], projects: {}, head: '', updated: '', source: '' }, stores = {};
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
      one.firmware.forEach(function (f) { if (c.boards[f.board] && c.boards[f.board].repo === r.full) { f.repo = r.full; c.firmware.push(f); } });
      stores[r.full] = r;
      if (r.raw.updated > c.updated) c.updated = r.raw.updated;
    });
    c.head = loaded.repos.map(function (r) { return r.head; }).join(',');
    c.source = loaded.repos.length === 1 ? loaded.repos[0].full : loaded.repos.length + ' repositories';
    c.fetch = function (f) { var r = stores[f.repo]; return r.store.readVerified(f.path, f.sha256, r.entries); };
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
      if (!Object.keys(parts.move.boards).length) throw new Error('No board in ' + dataFull() + ' belongs to project “' + pid + '”.');
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
      log('Copying ' + parts.firmware.length + ' firmware file' + (parts.firmware.length === 1 ? '' : 's') + '…');
      return Promise.all(parts.firmware.map(function (f) {
        return data.readVerified(f.path, f.sha256, src.entries).then(function (bytes) { return { path: f.path, bytes: bytes }; });
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
      var files = [{ path: 'manifest.json', text: dump(parts.keep) }].concat(parts.firmware.map(function (f) { return { path: f.path, remove: true }; }));
      return data.putFiles(files, { message: 'Flasher: ' + name + ' moved to ' + dstFull });
    }).then(function () {
      var ftes = M.liveUsers(roster).filter(function (u) { return u.role === 'fte' && u.login !== FL.config.owner.toLowerCase(); }).map(function (u) { return u.login; });
      return invite(ctx, dstFull, ftes, log);
    }).then(function (failed) { return { repo: dstFull, roster: roster, failed: failed }; });
  }

  FL.access = { PREFIX: PREFIX, full: full, dataFull: dataFull, dump: dump, projectOf: projectOf, projectsIn: projectsIn, split: split,
    readRepo: readRepo, load: load, combine: combine, saveRoster: saveRoster, invite: invite, revoke: revoke, accessMap: accessMap, share: share };
})(window.FL = window.FL || {});
