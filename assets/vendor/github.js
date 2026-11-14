/* Shared Signoff engine (EE, ME, and FW). Edit it in ee_design_review only; me_design_review and
   fw_design_review vendor it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* GitHub storage for Signoff.

   Every repository Signoff writes to has the same layout: projects/<id>.json, plus
   users.json in the FTE-only data repo. A sync of one repository = pull, merge, push one
   commit. Review data is committed straight to the branch (no pull requests): every record
   merges key by key (see model.mergeProjects), so two reviewers syncing the same project
   don't overwrite each other. The ref update uses force:false, so if someone else pushed
   in between, GitHub refuses it (422) and we pull, merge, and try again.

   assets/workspace.js decides which repositories to sync; this file talks to one.
   The fetch function is injected so tests/test.html can run this against a fake GitHub. */
(function (S) {
  'use strict';
  var M = S.model;

  var API = 'https://api.github.com';
  var MAX_ATTEMPTS = 4;

  function b64Encode(text) {
    var bytes = new TextEncoder().encode(text), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64Decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // Git's blob id: sha1("blob <byte length>\0" + content). Lets us know the sha of a
  // file we just pushed without asking GitHub.
  function gitBlobSha(text) {
    var body = new TextEncoder().encode(text);
    var head = new TextEncoder().encode('blob ' + body.length + '\0');
    var all = new Uint8Array(head.length + body.length);
    all.set(head, 0); all.set(body, head.length);
    return crypto.subtle.digest('SHA-1', all).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  // Binary-safe versions, for files such as fab packages (assets: docs/fabcheck-link.md).
  function bytesToB64(bytes) {
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    var bin = atob(String(b64).replace(/\s/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function gitBlobShaBytes(body) {
    var head = new TextEncoder().encode('blob ' + body.length + '\0');
    var all = new Uint8Array(head.length + body.length);
    all.set(head, 0); all.set(body, head.length);
    return crypto.subtle.digest('SHA-1', all).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  // Sign in with GitHub (auth.js): a token from a sign-in lasts 8 hours, so a store made earlier may
  // hold one that has since been replaced. Calls made with a sign-in's token use the current one,
  // refreshed first when it's due, and a 401 refreshes once and retries (GitHub refuses a 401 before
  // doing anything, so a retried write is safe). A pasted token, or no window, is used as it is.
  function signInFor(token) {
    var A = typeof window !== 'undefined' && window.SignoffAuth;
    return A && token && A.owns(token) ? A : null;
  }

  function apiCall(fetchImpl, token, url, opts) {
    opts = opts || {};
    var A = signInFor(token);
    function send(tok) {
      var headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (tok) headers.Authorization = 'Bearer ' + tok;
      if (opts.body) headers['Content-Type'] = 'application/json';
      return fetchImpl(url, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
    }
    var used;
    var first = A ? A.token().then(function (t) { used = t || token; return send(used); }) : send(token);
    return first
      .then(function (res) {
        if (!A || res.status !== 401) return res;
        return A.refresh(used).then(function (t) { return t ? send(t) : res; });
      })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (!res.ok) {
            var err = new Error((data && data.message) || ('HTTP ' + res.status));
            err.status = res.status;
            throw err;
          }
          return data;
        });
      });
  }

  // ── Calls about the signed-in user rather than one repository ──
  function GitHubAccount(token, fetchImpl) {
    this.token = token;
    this.fetch = fetchImpl || window.fetch.bind(window);
  }
  GitHubAccount.prototype.api = function (path, opts) { return apiCall(this.fetch, this.token, API + path, opts); };
  GitHubAccount.prototype.user = function () { return this.api('/user'); };
  // 'User' or 'Organization': decides where new project repositories are created.
  GitHubAccount.prototype.ownerType = function (owner) {
    return this.api('/users/' + encodeURIComponent(owner)).then(function (u) { return u.type; });
  };
  // Repositories of `owner` whose name starts with `prefix` that this token can open.
  GitHubAccount.prototype.listRepos = function (owner, prefix) {
    var self = this, out = [];
    function page(n) {
      return self.api('/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=' + n).then(function (list) {
        (list || []).forEach(function (r) {
          if (r.owner && r.owner.login.toLowerCase() === owner.toLowerCase() && r.name.indexOf(prefix) === 0) out.push(r.name);
        });
        return list && list.length === 100 && n < 20 ? page(n + 1) : out;
      });
    }
    return page(1);
  };
  GitHubAccount.prototype.createRepo = function (owner, name, isOrg, description) {
    var body = { name: name, private: true, auto_init: true, description: description || '' };
    return this.api(isOrg ? '/orgs/' + encodeURIComponent(owner) + '/repos' : '/user/repos', { method: 'POST', body: body });
  };
  // Invitations waiting for this user to accept (the email step people miss).
  GitHubAccount.prototype.invitations = function () {
    return this.api('/user/repository_invitations?per_page=100').then(function (list) {
      return (list || []).map(function (i) { return { id: i.id, repo: i.repository && i.repository.full_name, owner: i.repository && i.repository.owner && i.repository.owner.login }; });
    });
  };
  GitHubAccount.prototype.disableActions = function (owner, repo) {
    return this.api('/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/actions/permissions', { method: 'PUT', body: { enabled: false } });
  };
  GitHubAccount.prototype.acceptInvitation = function (id) {
    return this.api('/user/repository_invitations/' + id, { method: 'PATCH' });
  };

  // ── One repository ──
  function GitHubStore(cfg, fetchImpl) {
    this.cfg = cfg;               // { owner, repo, branch, dataPath, templatePath, token, summarize, merge }
    this.fetch = fetchImpl || window.fetch.bind(window);
  }

  GitHubStore.prototype.base = function () {
    return API + '/repos/' + encodeURIComponent(this.cfg.owner) + '/' + encodeURIComponent(this.cfg.repo);
  };
  GitHubStore.prototype.full = function () { return this.cfg.owner + '/' + this.cfg.repo; };

  GitHubStore.prototype.api = function (path, opts) {
    return apiCall(this.fetch, this.cfg.token, path.indexOf('http') === 0 ? path : this.base() + path, opts);
  };

  GitHubStore.prototype.dataDir = function () {
    return this.cfg.dataPath ? this.cfg.dataPath.replace(/\/+$/, '') + '/' : '';
  };
  GitHubStore.prototype.projectsDir = function () { return this.dataDir() + 'projects/'; };

  GitHubStore.prototype.user = function () { return this.api(API + '/user'); };

  // Head commit, its tree, and the files in it.
  GitHubStore.prototype.snapshot = function () {
    var self = this, head, branch = this.cfg.branch || 'main';
    return this.api('/git/ref/heads/' + encodeURIComponent(branch)).then(function (ref) {
      head = ref.object.sha;
      return self.api('/git/commits/' + head);
    }).then(function (commit) {
      return self.api('/git/trees/' + commit.tree.sha + '?recursive=1').then(function (tree) {
        return { head: head, tree: commit.tree.sha, entries: tree.tree || [] };
      });
    }).catch(function (err) {
      if (err.status === 409) err.message = self.full() + ' is empty. It needs a first commit before Signoff can sync it.';
      if (err.status === 404) err.message = self.full() + ' not found, or your token can’t open it.';
      throw err;
    });
  };

  GitHubStore.prototype.blob = function (sha) {
    return this.api('/git/blobs/' + sha).then(function (b) { return b64Decode(b.content); });
  };

  /* Sync this repository.
     local:  { projectId: doc }    working copies that live here, including unsynced edits
     roster: { users, shared }     the local People list (data repo only; pass null otherwise)
     cache:  { path: { sha } }     blob shas as of the last sync of this repo. A project whose
                                   sha hasn't changed since is already merged into the local
                                   copy, so it isn't downloaded again.
     opts.belongsHere(id, roster): projects it rejects (moved to their own repository) are
                                   not downloaded or pushed; local copies come back in `moved`,
                                   and with opts.deleteStrays their files here are deleted.
     opts.tool:                    also read checklists (templates/) and the tool version.
     cfg.summarize(doc):           builds the summary written into each project file
                                   (model.withSummary); without it the stored one is kept.
     cfg.merge(local, remote):     merges two copies of a document; default model.mergeProjects.
                                   Tools whose documents aren't reviews (Signoff PL) pass their own.
     opts.dropGone, opts.keepLocal(id): see `gone` below.
     opts.mergeOpts(id):           the third argument to cfg.merge for that project (model.mergeProjects
                                   takes { since, base }; see model.mergeSpec).
     opts.edited(id):              false when this browser has no unsynced edits to that project. Then
                                   GitHub's copy is taken as it is and never written back, not even
                                   a summary: a browser that changed nothing can't change the file
                                   (2026-11-13: an unedited copy wrote conflict copies and a reordered
                                   summary). Without it every merged project is a candidate, as before.
     Resolves { projects, roster, moved, gone, cache, templates, version, pushed, commitUrl };
     gone: local copies of projects deleted here since the last sync (with opts.dropGone).
     templates is null when they haven't changed since the last sync. */
  GitHubStore.prototype.sync = function (local, roster, cache, opts) {
    var self = this;
    opts = opts || {};
    local = local || {};
    var belongsHere = opts.belongsHere || function () { return true; };
    var merge = self.cfg.merge || M.mergeProjects;
    var attempt = 0;
    cache = cache || {};

    function fetchText(e) {
      return self.blob(e.sha).then(function (text) { return { path: e.path, sha: e.sha, text: text }; });
    }
    function idOf(path, dir) { return path.slice(dir.length).replace(/\.json$/, ''); }
    // Small files (roster, version) keep their text in the cache.
    function cachedText(e) {
      if (!e) return Promise.resolve(null);
      var c = cache[e.path];
      if (c && c.sha === e.sha && c.text != null) return Promise.resolve({ path: e.path, sha: e.sha, text: c.text });
      return fetchText(e);
    }

    function once() {
      attempt++;
      var snap, blobs, projectEntries, strays = [], rosterEntry, mergedRoster = null, templates = null, version = null;
      var nextCache = Object.assign({}, cache);   // only returned once the sync succeeds
      var dir = self.projectsDir();
      var rosterPath = self.dataDir() + 'users.json';
      var tplDir = (self.cfg.templatePath || 'templates').replace(/\/+$/, '') + '/';
      var direct = function (e, base) { return e.path.indexOf(base) === 0 && /\.json$/.test(e.path) && e.path.slice(base.length).indexOf('/') < 0; };
      var fresh = function (e) { return !(cache[e.path] && cache[e.path].sha === e.sha); };
      return self.snapshot().then(function (s) {
        snap = s;
        blobs = s.entries.filter(function (e) { return e.type === 'blob'; });
        rosterEntry = roster ? blobs.filter(function (e) { return e.path === rosterPath; })[0] : null;
        // The roster comes first: it says which projects have moved to their own repository.
        return cachedText(rosterEntry);
      }).then(function (rf) {
        if (roster) {
          var remoteRoster = null;
          if (rf) {
            nextCache[rf.path] = { sha: rf.sha, text: rf.text };
            try { remoteRoster = JSON.parse(rf.text); } catch (e) { remoteRoster = null; }
          }
          mergedRoster = M.mergeRosters(roster, remoteRoster);
        }
        projectEntries = [];
        blobs.forEach(function (e) {
          if (!direct(e, dir)) return;
          (belongsHere(idOf(e.path, dir), mergedRoster) ? projectEntries : strays).push(e);
        });
        // Projects: fetch only what changed, or what we have no local copy of.
        var projectReads = projectEntries.map(function (e) {
          return fresh(e) || !local[idOf(e.path, dir)] ? fetchText(e) : Promise.resolve({ path: e.path, sha: e.sha, unchanged: true });
        });
        var tplReads = Promise.resolve(null), versionRead = Promise.resolve(null);
        if (opts.tool) {
          var tplEntries = blobs.filter(function (e) { return direct(e, tplDir); });
          var versionEntry = blobs.filter(function (e) { return e.path === 'assets/version.js'; })[0];
          // Templates: all of them again if any changed, otherwise nothing.
          tplReads = tplEntries.some(fresh) || tplEntries.length !== Object.keys(cache).filter(function (k) { return k.indexOf(tplDir) === 0; }).length
            ? Promise.all(tplEntries.map(fetchText)) : Promise.resolve(null);
          tplEntries.forEach(function (e) { nextCache[e.path] = { sha: e.sha }; });
          versionRead = cachedText(versionEntry);
        }
        return Promise.all([Promise.all(projectReads), tplReads, versionRead]);
      }).then(function (got) {
        if (got[1]) {
          templates = [];
          got[1].forEach(function (f) {
            try { templates.push(JSON.parse(f.text)); } catch (e) { /* a broken template file is skipped */ }
          });
        }
        if (got[2]) {
          nextCache[got[2].path] = { sha: got[2].sha, text: got[2].text };
          var m = /hash:\s*'([0-9a-f]+)'[\s\S]*?date:\s*'([^']*)'/.exec(got[2].text);
          if (m) version = { hash: m[1], date: m[2] };
        }

        var remote = {};
        got[0].forEach(function (f) {
          var id = idOf(f.path, dir);
          if (f.unchanged) { remote[id] = { path: f.path, sha: f.sha, unchanged: true }; return; }
          var doc = null;
          try { doc = JSON.parse(f.text); } catch (e) { /* unreadable project file: leave it alone */ }
          // A file holds the project its name says, or it is left alone: a file that claims
          // another project's id must never merge into that project.
          if (doc && typeof doc === 'object' && doc.id === id) remote[id] = { doc: doc, path: f.path, sha: f.sha };
        });

        // Local copies of projects that now live elsewhere are handed back, never pushed here.
        var moved = Object.keys(local).filter(function (id) { return !belongsHere(id, mergedRoster); });
        // With opts.dropGone, a local copy whose file the last sync saw here but which is gone
        // now was deleted on GitHub: it comes back in `gone` instead of being pushed again,
        // unless opts.keepLocal(id) says it has unsynced edits.
        var present = {};
        projectEntries.forEach(function (e) { present[e.path] = 1; });
        var gone = Object.keys(local).filter(function (id) {
          var p = dir + id + '.json';
          return opts.dropGone && moved.indexOf(id) < 0 && !present[p] && cache[p] && !(opts.keepLocal && opts.keepLocal(id));
        });
        var merged = {}, candidates = [];
        var ids = Object.keys(remote).concat(Object.keys(local).filter(function (id) { return !remote[id] && moved.indexOf(id) < 0 && gone.indexOf(id) < 0; }));
        ids.forEach(function (id) {
          var r = remote[id];
          var untouched = !!r && !!opts.edited && !opts.edited(id);
          var doc = r && r.unchanged ? local[id] : untouched ? r.doc : merge(local[id], r && r.doc, opts.mergeOpts ? opts.mergeOpts(id) : undefined);
          if (!doc) return;
          merged[id] = doc;
          if (untouched) return;   // nothing of ours to write
          var written = M.withSummary(doc, self.cfg.summarize);
          candidates.push({ path: r ? r.path : dir + id + '.json', text: M.stableStringify(written), label: doc.meta.name, sha: r && r.sha });
        });
        projectEntries.forEach(function (e) { nextCache[e.path] = { sha: e.sha }; });
        if (mergedRoster && (Object.keys(mergedRoster.users).length || Object.keys(mergedRoster.shared).length)) {
          candidates.push({ path: rosterPath, text: M.stableStringify(mergedRoster), label: 'people', sha: rosterEntry && rosterEntry.sha, roster: true });
        }

        return Promise.all(candidates.map(function (c) {
          return gitBlobSha(c.text).then(function (sha) { c.newSha = sha; return c; });
        })).then(function (all) {
          var changes = all.filter(function (c) { return c.newSha !== c.sha; });
          if (opts.deleteStrays) {
            strays.forEach(function (e) { changes.push({ path: e.path, remove: true, label: 'move ' + idOf(e.path, dir) }); });
          }
          var result = { projects: merged, roster: mergedRoster, moved: moved, gone: gone, cache: nextCache, templates: templates, version: version, pushed: 0 };
          if (!changes.length || opts.pullOnly) return result;
          return self.commit(snap, changes, opts.message).then(function (commit) {
            changes.forEach(function (c) {
              if (c.remove) delete nextCache[c.path];
              else nextCache[c.path] = c.roster ? { sha: c.newSha, text: c.text } : { sha: c.newSha };
            });
            result.pushed = changes.length;
            result.commitUrl = commit.html_url;
            return result;
          });
        }).catch(function (err) {
          // 422 "not a fast forward" (or 409): someone pushed first. Pull, merge, retry.
          if ((err.status === 422 || err.status === 409) && attempt < MAX_ATTEMPTS) {
            if (opts.onRetry) opts.onRetry(attempt);
            return once();
          }
          throw err;
        });
      });
    }
    return once();
  };

  /* Writes records into one map of one project file (kind: 'reqs') and changes nothing else.
     For a writer that doesn't own the document (Signoff PL writing requirements into a review).
     It never merges the whole document, so fields this copy of the engine doesn't know survive.
       records:     [record with id], each stamped by the caller
       opts.bases:  { id: updatedAt the caller started editing from ('' = it was new) }. A stored
                    record that has moved on since is a conflict: it is not written.
       opts.message the commit message
     A record is written only where it's new or newer (model.newer) than the stored one. Before
     committing it proves the write is additive: the file with the written ids taken out must
     re-serialize to the original with them taken out, byte for byte. The file must round-trip
     through stableStringify, or nothing is written. One commit, force:false; when someone
     pushed first it reads again and redoes the patch. Afterwards it reads the file back.
     Resolves { written: [ids], skipped: [ids], conflicts: [{ id, theirs }], commitUrl }. */
  GitHubStore.prototype.patchRecords = function (path, kind, records, opts) {
    var self = this, attempt = 0;
    opts = opts || {};
    var bases = opts.bases || {};
    function readFile(snap) {
      var e = snap.entries.filter(function (x) { return x.type === 'blob' && x.path === path; })[0];
      if (!e) { var err = new Error(path + ' isn’t in ' + self.full()); err.status = 404; throw err; }
      return self.blob(e.sha);
    }
    function once() {
      attempt++;
      var snap, written = [], skipped = [], conflicts = [];
      return self.snapshot().then(function (s) {
        snap = s;
        if (!snap.head) { var err = new Error(self.full() + ' is empty'); err.status = 404; throw err; }
        return readFile(snap);
      }).then(function (text) {
        var doc = JSON.parse(text);
        if (M.stableStringify(doc) !== text) throw new Error(path + ' wasn’t written by Signoff, so it isn’t changed');
        var map = doc[kind] && typeof doc[kind] === 'object' ? doc[kind] : {};
        var next = Object.assign({}, doc);
        next[kind] = Object.assign({}, map);
        records.forEach(function (rec) {
          var cur = map[rec.id];
          if (cur && Object.prototype.hasOwnProperty.call(bases, rec.id) && (cur.updatedAt || '') !== bases[rec.id]) {
            conflicts.push({ id: rec.id, theirs: cur }); return;
          }
          if (cur && (M.newer(cur, rec) !== rec || M.stableStringify(cur) === M.stableStringify(rec))) { skipped.push(rec.id); return; }
          next[kind][rec.id] = rec;
          written.push(rec.id);
        });
        var result = { written: written, skipped: skipped, conflicts: conflicts };
        if (!written.length) return result;
        function without(d) {
          var c = Object.assign({}, d);
          c[kind] = Object.assign({}, d[kind] || {});
          written.forEach(function (id) { delete c[kind][id]; });
          if (!d[kind]) delete c[kind];
          return M.stableStringify(c);
        }
        if (without(doc) !== without(next)) throw new Error('The write to ' + path + ' would change more than the records it was given, so it was stopped');
        var out = M.stableStringify(next);
        return self.commit(snap, [{ path: path, text: out, label: path }], opts.message).then(function (commit) {
          result.commitUrl = commit.html_url;
          return self.snapshot().then(readFile).then(function (back) {
            var got = JSON.parse(back)[kind] || {};
            var missing = written.filter(function (id) { return M.stableStringify(got[id]) !== M.stableStringify(next[kind][id]); });
            if (missing.length) throw new Error('Read back from ' + path + ': ' + missing.join(', ') + ' didn’t stick');
            return result;
          });
        });
      }).catch(function (err) {
        if ((err.status === 422 || err.status === 409) && attempt < MAX_ATTEMPTS) return once();
        throw err;
      });
    }
    return once();
  };

  GitHubStore.prototype.commit = function (snap, changes, message) {
    var self = this;
    return this.api('/git/trees', { method: 'POST', body: {
      base_tree: snap.tree,
      tree: changes.map(function (c) {
        if (c.remove) return { path: c.path, mode: '100644', type: 'blob', sha: null };
        if (c.blobSha) return { path: c.path, mode: '100644', type: 'blob', sha: c.blobSha };
        return { path: c.path, mode: '100644', type: 'blob', content: c.text };
      })
    } }).then(function (tree) {
      return self.api('/git/commits', { method: 'POST', body: {
        message: message || ('Signoff: update ' + changes.map(function (c) { return c.label; }).join(', ')),
        tree: tree.sha,
        parents: [snap.head]
      } });
    }).then(function (commit) {
      return self.api('/git/refs/heads/' + encodeURIComponent(self.cfg.branch || 'main'), { method: 'PATCH', body: { sha: commit.sha, force: false } })
        .then(function () { return commit; });
    });
  };

  // ── Files outside the review documents (Fabcheck packages and runs) ──

  // Blob files under `prefix` on the branch: [{ path, sha, size }].
  GitHubStore.prototype.listTree = function (prefix) {
    return this.snapshot().then(function (s) {
      return s.entries.filter(function (e) { return e.type === 'blob' && e.path.indexOf(prefix || '') === 0; })
        .map(function (e) { return { path: e.path, sha: e.sha, size: e.size }; });
    });
  };
  GitHubStore.prototype.blobBytes = function (sha) {
    return this.api('/git/blobs/' + sha).then(function (b) { return b64ToBytes(b.content); });
  };
  // One file's bytes, or null if it isn't there. Pass `entries` from listTree to save a call.
  GitHubStore.prototype.readBytes = function (path, entries) {
    var self = this;
    return (entries ? Promise.resolve(entries) : this.listTree(path)).then(function (list) {
      var e = list.filter(function (x) { return x.path === path; })[0];
      return e ? self.blobBytes(e.sha) : null;
    });
  };

  // The run files a checker stored under `dir` (Fabcheck's fabcheck/<projectId>/), parsed but not
  // checked (model.cleanRun does that): resolves { entries, runs: [{ path, data }] }. `entries`
  // is the listing, to pass on to readBytes / readVerified. A file that isn't JSON is skipped.
  GitHubStore.prototype.listRuns = function (dir) {
    var self = this, base = dir + 'runs/';
    return this.listTree(dir).then(function (entries) {
      var files = entries.filter(function (e) { return e.path.indexOf(base) === 0 && /^[^/]+\.json$/.test(e.path.slice(base.length)); });
      return Promise.all(files.map(function (e) {
        return self.blobBytes(e.sha).then(function (b) {
          try { return { path: e.path, data: JSON.parse(new TextDecoder().decode(b)) }; } catch (err) { return null; }
        });
      })).then(function (runs) { return { entries: entries, runs: runs.filter(Boolean) }; });
    });
  };

  // A file's bytes, checked against the SHA-256 its record gives. Rejects with err.code 'missing'
  // when it isn't there and 'mismatch' when its checksum differs, so a changed file is never used.
  GitHubStore.prototype.readVerified = function (path, sha256, entries) {
    return this.readBytes(path, entries).then(function (bytes) {
      if (!bytes) { var e1 = new Error(path + ' isn’t in the repository'); e1.code = 'missing'; throw e1; }
      return sha256Hex(bytes).then(function (got) {
        if (got !== String(sha256 || '').toLowerCase()) { var e2 = new Error(path + ' doesn’t match its recorded SHA-256'); e2.code = 'mismatch'; throw e2; }
        return bytes;
      });
    });
  };

  function sha256Hex(bytes) {
    return crypto.subtle.digest('SHA-256', bytes).then(function (d) {
      return Array.prototype.map.call(new Uint8Array(d), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  /* Write several files in one commit.
     files: [{ path, bytes: Uint8Array } | { path, text } | { path, remove: true }]
     opts:  { message, onRetry(attempt), onProgress(done, total) }
     Files whose content already matches are skipped, so writing the same package twice
     uploads nothing. Binary content goes up as blobs first; the commit then uses
     force:false and is retried on a non-fast-forward, like sync.
     Resolves { pushed, skipped, commitUrl }. */
  GitHubStore.prototype.putFiles = function (files, opts) {
    var self = this, attempt = 0, uploaded = {};
    opts = opts || {};
    var items = files.map(function (f) {
      return f.remove ? { path: f.path, remove: true } : { path: f.path, bytes: f.bytes || new TextEncoder().encode(f.text || '') };
    });
    return Promise.all(items.map(function (it) {
      return it.remove ? it : gitBlobShaBytes(it.bytes).then(function (sha) { it.sha = sha; return it; });
    })).then(function once() {
      attempt++;
      return self.snapshot().then(function (snap) {
        var have = {};
        snap.entries.forEach(function (e) { if (e.type === 'blob') have[e.path] = e.sha; });
        var changes = items.filter(function (it) { return it.remove ? !!have[it.path] : have[it.path] !== it.sha; });
        var skipped = items.length - changes.length;
        if (!changes.length) return { pushed: 0, skipped: skipped };
        var toUpload = changes.filter(function (it) { return !it.remove && !uploaded[it.sha]; });
        var done = 0, next = 0;
        function worker() {
          if (next >= toUpload.length) return Promise.resolve();
          var it = toUpload[next++];
          return self.api('/git/blobs', { method: 'POST', body: { content: bytesToB64(it.bytes), encoding: 'base64' } }).then(function (b) {
            if (b.sha !== it.sha) throw new Error('GitHub stored ' + it.path + ' with a different checksum');
            uploaded[it.sha] = true;
            done++;
            if (opts.onProgress) opts.onProgress(done, toUpload.length);
            return worker();
          });
        }
        return Promise.all([worker(), worker(), worker(), worker()]).then(function () {
          return self.commit(snap, changes.map(function (it) {
            return it.remove ? { path: it.path, remove: true } : { path: it.path, blobSha: it.sha };
          }), opts.message || 'Signoff: update files');
        }).then(function (commit) {
          return { pushed: changes.length, skipped: skipped, commitUrl: commit.html_url };
        });
      }).catch(function (err) {
        if ((err.status === 422 || err.status === 409) && attempt < MAX_ATTEMPTS) {
          if (opts.onRetry) opts.onRetry(attempt);
          return once();
        }
        throw err;
      });
    });
  };

  // ── Who can open this repository. On a personal account only the owner can change it;
  // in an organization, its admins can. Needs Administration access on the token.
  GitHubStore.prototype.collaborators = function () {
    return this.api('/collaborators?per_page=100').then(function (list) { return (list || []).map(function (u) { return u.login.toLowerCase(); }); });
  };
  GitHubStore.prototype.invitations = function () {
    return this.api('/invitations?per_page=100').then(function (list) {
      return (list || []).map(function (i) { return { id: i.id, login: ((i.invitee && i.invitee.login) || '').toLowerCase() }; });
    });
  };
  GitHubStore.prototype.invite = function (login) {
    return this.api('/collaborators/' + encodeURIComponent(login), { method: 'PUT', body: { permission: 'push' } });
  };
  // Takes away access, including an invitation not yet accepted.
  GitHubStore.prototype.revoke = function (login) {
    var self = this;
    login = login.toLowerCase();
    return this.invitations().then(function (inv) {
      return Promise.all(inv.filter(function (i) { return i.login === login; }).map(function (i) {
        return self.api('/invitations/' + i.id, { method: 'DELETE' });
      }));
    }).then(function () {
      return self.api('/collaborators/' + encodeURIComponent(login), { method: 'DELETE' }).catch(function (err) { if (err.status !== 404) throw err; });
    });
  };

  // ── Hand-off to Fabcheck (docs/fabcheck-link.md, "Opening a run from Signoff") ──
  // Fabcheck never reads a review's repo. Signoff reads a stored run and its package zip with its
  // own token and leaves them in IndexedDB, where Fabcheck (same origin) takes the entry when it
  // opens the run's link: database dovetail-handoff (dovetail-handoff-demo in demo mode), store
  // runs, keyed by run id, { id, run, findings, zip: Uint8Array, at }.
  function handoffDb(demo) {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(demo ? 'dovetail-handoff-demo' : 'dovetail-handoff', 1);
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains('runs')) r.result.createObjectStore('runs', { keyPath: 'id' }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function handoffTx(demo, mode, fn) {
    return handoffDb(demo).then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction('runs', mode), q = fn(t.objectStore('runs'));
        t.oncomplete = function () { d.close(); res(q && q.result); };
        t.onerror = function () { d.close(); rej(t.error); };
      });
    });
  }
  var handoff = {
    put: function (entry, demo) { return handoffTx(demo, 'readwrite', function (s) { return s.put(entry); }); },
    get: function (id, demo) { return handoffTx(demo, 'readonly', function (s) { return s.get(id); }); },
    remove: function (id, demo) { return handoffTx(demo, 'readwrite', function (s) { return s.delete(id); }); }
  };

  S.GitHubStore = GitHubStore;
  S.GitHubAccount = GitHubAccount;
  S.handoff = handoff;
  S.github = { b64Encode: b64Encode, b64Decode: b64Decode, gitBlobSha: gitBlobSha,
    bytesToB64: bytesToB64, b64ToBytes: b64ToBytes, gitBlobShaBytes: gitBlobShaBytes, sha256Hex: sha256Hex };
})(window.Signoff = window.Signoff || {});
