/* An in-memory GitHub for tests/test.js: enough of the REST API for the engine's GitHubStore and
   GitHubAccount (git data reads and writes, repo creation, collaborators, invitations), with GitHub's
   access rules: a repo is visible (else 404) only to its owner and its collaborators, an invitation
   gives nothing until it is accepted, and a ref update with force:false refuses a stale parent (422).

   var gh = FakeGitHub({ owner: 'acme', tokens: { tok: 'acme', bob: 'bob' } });
   gh.repo('data', { 'manifest.json': '…', 'firmware/x.bin': Uint8Array }) makes a repo with one commit;
   gh.fetch is the fetch to hand the store; gh.files('data') reads the current files back. */
(function () {
  'use strict';
  var G = window.Signoff.github;

  window.FakeGitHub = function (opts) {
    var owner = opts.owner, tokens = opts.tokens, repos = {}, trees = {}, commits = {}, blobs = {}, n = 0, invN = 100;
    var id = function (p) { n++; return (p + n.toString(16)).padEnd(40, '0').slice(0, 40); };
    var enc = function (x) { return typeof x === 'string' ? new TextEncoder().encode(x) : x; };

    function makeCommit(files, parent) {
      var t = id('7'), c = id('c');
      trees[t] = files; commits[c] = { tree: t, parent: parent || null };
      return c;
    }
    function putBlob(bytes) { return G.gitBlobShaBytes(bytes).then(function (sha) { blobs[sha] = bytes; return sha; }); }

    var api = {
      repo: function (name, files, extra) {
        var map = {}, keys = Object.keys(files || {});
        return Promise.all(keys.map(function (k) { return putBlob(enc(files[k])).then(function (sha) { map[k] = sha; }); })).then(function () {
          repos[name] = Object.assign({ name: name, head: makeCommit(map, null), collaborators: [], invitations: [], actions: true }, extra || {});
          return repos[name];
        });
      },
      files: function (name) {
        var r = repos[name]; if (!r) return null;
        var out = {}, t = trees[commits[r.head].tree];
        Object.keys(t).forEach(function (k) { out[k] = blobs[t[k]]; });
        return out;
      },
      text: function (name, path) { var f = api.files(name); return f && f[path] ? new TextDecoder().decode(f[path]) : null; },
      repos: repos
    };

    function res(status, body) {
      return Promise.resolve({ ok: status >= 200 && status < 300, status: status, text: function () { return Promise.resolve(body === undefined ? '' : JSON.stringify(body)); } });
    }
    function sees(login, r) { return r && (login === owner || r.collaborators.indexOf(login) >= 0); }

    api.fetch = function (url, init) {
      init = init || {};
      var method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
      var auth = (init.headers && init.headers.Authorization || '').replace('Bearer ', '');
      var login = tokens[auth];
      if (!login) return res(401, { message: 'Bad credentials' });
      var path = url.replace('https://api.github.com', '').split('?')[0], m;

      if (path === '/user') return res(200, { login: login });
      if ((m = /^\/users\/([^/]+)$/.exec(path))) return res(200, { login: m[1], type: 'User' });
      if (path === '/user/repos' && method === 'GET') {
        var pg = /[?&]page=(\d+)/.exec(url);
        if (pg && +pg[1] > 1) return res(200, []);
        return res(200, Object.keys(repos).filter(function (k) { return sees(login, repos[k]); }).map(function (k) { return { name: k, owner: { login: owner } }; }));
      }
      if (path === '/user/repos' && method === 'POST') {
        if (login !== owner) return res(403, { message: 'Forbidden' });
        if (repos[body.name]) return res(422, { message: 'name already exists on this account' });
        return api.repo(body.name, body.auto_init ? { 'README.md': '# ' + body.name + '\n' } : {}).then(function () { return res(201, { name: body.name, full_name: owner + '/' + body.name }); });
      }
      if (path === '/user/repository_invitations') {
        var list = [];
        Object.keys(repos).forEach(function (k) { repos[k].invitations.forEach(function (i) { if (i.login === login) list.push({ id: i.id, repository: { full_name: owner + '/' + k, owner: { login: owner } } }); }); });
        return res(200, list);
      }
      if ((m = /^\/user\/repository_invitations\/(\d+)$/.exec(path)) && method === 'PATCH') {
        var done = false;
        Object.keys(repos).forEach(function (k) {
          var r = repos[k], i = r.invitations.filter(function (x) { return String(x.id) === m[1] && x.login === login; })[0];
          if (i) { r.invitations.splice(r.invitations.indexOf(i), 1); r.collaborators.push(login); done = true; }
        });
        return res(done ? 204 : 404, done ? undefined : { message: 'Not Found' });
      }

      if (!(m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path))) return res(404, { message: 'Not Found' });
      var r = m[1] === owner ? repos[m[2]] : null, rest = m[3] || '';
      if (!sees(login, r)) return res(404, { message: 'Not Found' });
      var mm;

      if (rest === '/git/ref/heads/main') return res(200, { object: { sha: r.head } });
      if ((mm = /^\/git\/commits\/(\w+)$/.exec(rest)) && method === 'GET') return commits[mm[1]] ? res(200, { sha: mm[1], tree: { sha: commits[mm[1]].tree } }) : res(404, {});
      if ((mm = /^\/git\/trees\/(\w+)$/.exec(rest)) && method === 'GET') {
        var t = trees[mm[1]]; if (!t) return res(404, {});
        return res(200, { tree: Object.keys(t).map(function (k) { return { path: k, type: 'blob', sha: t[k], size: blobs[t[k]].length }; }), truncated: false });
      }
      if ((mm = /^\/git\/blobs\/(\w+)$/.exec(rest)) && method === 'GET') return blobs[mm[1]] ? res(200, { content: G.bytesToB64(blobs[mm[1]]), encoding: 'base64' }) : res(404, {});
      if (rest === '/git/blobs' && method === 'POST') return putBlob(G.b64ToBytes(body.content)).then(function (sha) { return res(201, { sha: sha }); });
      if (rest === '/git/trees' && method === 'POST') {
        var files = Object.assign({}, trees[body.base_tree] || {});
        return Promise.all(body.tree.map(function (e) {
          if (e.sha === null) { delete files[e.path]; return null; }
          if (e.sha) { files[e.path] = e.sha; return null; }
          return putBlob(enc(e.content)).then(function (sha) { files[e.path] = sha; });
        })).then(function () { var tid = id('7'); trees[tid] = files; return res(201, { sha: tid }); });
      }
      if (rest === '/git/commits' && method === 'POST') { var cid = id('c'); commits[cid] = { tree: body.tree, parent: body.parents[0] }; return res(201, { sha: cid, html_url: 'https://github.com/x/commit/' + cid }); }
      if (rest === '/git/refs/heads/main' && method === 'PATCH') {
        if (login !== owner && r.collaborators.indexOf(login) < 0) return res(404, {});
        if (commits[body.sha].parent !== r.head && !body.force) return res(422, { message: 'Update is not a fast forward' });
        r.head = body.sha; return res(200, { object: { sha: body.sha } });
      }
      if (rest === '/actions/permissions' && method === 'PUT') { r.actions = body.enabled; return res(204); }
      if (rest === '/collaborators' && method === 'GET') return res(200, [owner].concat(r.collaborators).map(function (l) { return { login: l }; }));
      if ((mm = /^\/collaborators\/([^/]+)$/.exec(rest))) {
        var who = decodeURIComponent(mm[1]).toLowerCase();
        if (login !== owner) return res(403, { message: 'Must have admin rights' });
        if (method === 'PUT') {
          if (who === owner || r.collaborators.indexOf(who) >= 0 || r.invitations.some(function (i) { return i.login === who; })) return res(204);
          r.invitations.push({ id: ++invN, login: who }); return res(201, { id: invN });
        }
        if (method === 'DELETE') { var k = r.collaborators.indexOf(who); if (k < 0) return res(404, {}); r.collaborators.splice(k, 1); return res(204); }
      }
      if (rest === '/invitations' && method === 'GET') return res(200, r.invitations.map(function (i) { return { id: i.id, invitee: { login: i.login } }; }));
      if ((mm = /^\/invitations\/(\d+)$/.exec(rest)) && method === 'DELETE') { r.invitations = r.invitations.filter(function (i) { return String(i.id) !== mm[1]; }); return res(204); }
      return res(404, { message: 'Not Found: ' + method + ' ' + rest });
    };
    return api;
  };
})();
