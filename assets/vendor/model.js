/* Shared Signoff engine (EE, ME, and FW). Edit it in ee_design_review only; me_design_review and
   fw_design_review vendor it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* Signoff data model: templates, project documents, progress, and merging.
   Pure functions only (no DOM, no storage) so tests/test.html can exercise them. */
(function (S) {
  'use strict';

  var STATUSES = ['open', 'pass', 'issue', 'na'];
  var SEVERITIES = ['critical', 'major', 'minor'];
  var RESOLUTIONS = ['', 'fixed', 'waived'];

  // Discipline specifics (tags, stages, ID prefixes) come from assets/config.js, which
  // tools/validate_templates.py reads too.
  var C = S.config = window.SIGNOFF_CONFIG || {};
  var TAGS = C.tags || [];
  var STAGES = C.stages || [];
  var IDS = C.ids || {};

  function now() { return new Date().toISOString(); }

  // A value from a fixed list, or the fallback. Review files come from repositories other
  // people can write to, so a field that picks a CSS class or a label is never used as is.
  function oneOf(list, value, fallback) { return list.indexOf(value) >= 0 ? value : fallback; }

  function uid(prefix) {
    return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // A short fingerprint of a GitHub token (FNV-1a), so a tool notices when the token it shares
  // with the other Signoff tools has changed. It can't be turned back into the token.
  // A token from Sign in with GitHub (ghu_…, while signed in) is replaced every 8 hours, so it's
  // fingerprinted by the signed-in login instead: a refresh is the same person, another account
  // isn't. The hub's copy in signoff/assets/hub.js must stay identical.
  function signedInLogin(token) {
    if (!/^ghu_/.test(token)) return '';
    try {
      if (typeof localStorage === 'undefined' || !localStorage.getItem('signoff.auth')) return '';
      return String(localStorage.getItem('signoff.login') || '');
    } catch (e) { return ''; }
  }
  function tokenTag(token) {
    var h = 0x811c9dc5;
    token = String(token || '');
    var login = signedInLogin(token);
    if (login) token = 'signin:' + login.toLowerCase();
    for (var i = 0; i < token.length; i++) { h ^= token.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function slugify(text) {
    return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
  }

  // ── Templates ────────────────────────────────────────────

  // Bundled templates (assets/templates.js) are the offline fallback. Templates pulled
  // from the repo win unless the bundled copy has a higher version (a newer local tool).
  function resolveTemplates(bundled, pulled) {
    var byId = {};
    (bundled || []).forEach(function (t) { byId[t.id] = t; });
    (pulled || []).forEach(function (t) {
      var b = byId[t.id];
      if (!b || (t.version || 0) >= (b.version || 0)) byId[t.id] = t;
    });
    var order = (bundled || []).map(function (t) { return t.id; });
    Object.keys(byId).forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
    return order.map(function (id) { return byId[id]; });
  }

  function indexTemplates(templates) {
    var items = {}, sections = {};
    templates.forEach(function (t) {
      t.sections.forEach(function (s) {
        sections[s.id] = { template: t, section: s };
        s.items.forEach(function (it) { items[it.id] = { template: t, section: s, item: it }; });
      });
    });
    return { items: items, sections: sections };
  }

  function applies(tags, profile) {
    if (!tags || !tags.length) return true;
    for (var i = 0; i < tags.length; i++) if (profile.indexOf(tags[i]) >= 0) return true;
    return false;
  }

  // ── Project documents ────────────────────────────────────

  function newProject(fields, user, templates) {
    var t = now();
    var versions = {};
    (templates || []).forEach(function (tp) { versions[tp.id] = tp.version || 1; });
    return {
      schema: 1,
      id: uid(IDS.project || 'p'),
      slug: slugify(fields.name),
      createdAt: t,
      createdBy: user || '',
      templateVersions: versions,
      meta: {
        name: fields.name || 'Untitled project',
        project: fields.project || '',
        client: fields.client || '',
        board: fields.board || '',
        revision: fields.revision || '',
        stage: fields.stage || C.defaultStage || STAGES[0] || '',
        description: fields.description || '',
        profile: (fields.profile || []).slice(),
        checklists: (fields.checklists || []).slice(),
        archived: false,
        updatedAt: t,
        updatedBy: user || ''
      },
      items: {},
      sections: {},
      comments: {},
      custom: {},
      reqs: {}
    };
  }

  function stamp(rec, user) {
    rec.updatedAt = now();
    rec.updatedBy = user || '';
    return rec;
  }

  // The rows of one checklist in a project: template items in order, then the
  // project's custom items for each section. Each row carries its effective status.
  function checklistRows(project, template) {
    var profile = project.meta.profile || [];
    var customs = Object.keys(project.custom).map(function (k) { return project.custom[k]; })
      .filter(function (c) { return !c.deleted && c.checklist === template.id; })
      .sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); });
    return template.sections.map(function (s) {
      var secState = project.sections[s.id] || {};
      var secApplies = applies(s.tags, profile);
      var rows = s.items.map(function (it) {
        return row(project, it.id, it, applies(it.tags, profile) && secApplies, !!secState.na, false);
      });
      customs.filter(function (c) { return c.section === s.id; }).forEach(function (c) {
        rows.push(row(project, c.id, c, true, !!secState.na, true));
      });
      return { section: s, state: secState, applies: secApplies, rows: rows };
    });
  }

  function row(project, id, def, applicable, sectionNA, custom) {
    var st = project.items[id] || {};
    var explicit = st.status && st.status !== 'open' ? oneOf(STATUSES, st.status, '') : '';
    var status;
    if (explicit) status = explicit;
    else if (sectionNA) status = 'na';
    else if (!applicable && !st.include) status = 'na';
    else status = 'open';
    return {
      id: id,
      def: def,
      state: st,
      status: status,
      auto: !explicit && status === 'na' ? (sectionNA ? 'section' : 'profile') : '',
      hidden: !applicable && !st.include && !explicit,
      custom: custom,
      // A reference copy, not a check: findings a checker (Fabcheck) waived, kept to read. Counted
      // nowhere (progress, issue tallies, the project summary), and shown as waived info.
      reference: !!(custom && def.reference === true),
      severity: oneOf(SEVERITIES, st.severity, oneOf(SEVERITIES, def.severity, 'minor')),
      resolution: oneOf(RESOLUTIONS, st.resolution, ''),
      comments: 0
    };
  }

  // Checks set aside by the board profile aren't counted at all (a new review starts at
  // 0%). Section N/A is a reviewer's decision, so those count as reviewed. With nothing to review
  // (no checks, or a review of requirements only) it's 100% (Chris, 2026-11-09).
  // Reference rows (waived findings kept to read) aren't checks, so they count nowhere either.
  function countStatuses(rows) {
    var c = { total: 0, pass: 0, issue: 0, na: 0, open: 0, reviewed: 0, issuesOpen: 0, outside: 0, reference: 0 };
    rows.forEach(function (r) {
      if (r.reference) { c.reference++; return; }
      if (r.auto === 'profile') { c.outside++; return; }
      c.total++;
      c[r.status]++;
      if (r.status !== 'open') c.reviewed++;
      if (r.status === 'issue' && !r.resolution) c.issuesOpen++;
    });
    c.pct = c.total ? Math.round(100 * c.reviewed / c.total) : 100;
    return c;
  }

  function projectStats(project, templates) {
    var per = {}, all = [];
    templates.forEach(function (t) {
      if (project.meta.checklists.indexOf(t.id) < 0) return;
      var rows = [];
      checklistRows(project, t).forEach(function (g) { rows = rows.concat(g.rows); });
      per[t.id] = countStatuses(rows);
      all = all.concat(rows);
    });
    var total = countStatuses(all);
    total.per = per;
    return total;
  }

  // ── Summary ──────────────────────────────────────────────
  // A small digest written into each project file at sync (project.summary), so tools that
  // don't load this tool's checklists (Signoff PL) can show where a review stands. It is
  // derived, never merged: sync drops the old one and recomputes it from the document. It
  // depends only on the document and the checklists, so an unchanged project writes the same
  // bytes and isn't committed again. `at` / `by` are the latest edit in the document.
  function reqsEnabled(project) {
    if ((project.meta.checklists || []).indexOf('reqs') >= 0) return true;
    return !project.meta.reqsDecided && liveReqs(project).length > 0;
  }

  // Scribe (the description tab) is picked per review like a checklist ('spec' in meta.checklists), where the
  // tool offers it (config.spec). Reviews from before that choice show it if they have a description.
  function specEnabled(project) {
    if (!C.spec) return false;
    if ((project.meta.checklists || []).indexOf('spec') >= 0) return true;
    return !project.meta.specDecided && liveSpec(project).length > 0;
  }

  function lastEdit(project) {
    var last = { updatedAt: '', updatedBy: '' };
    function see(rec) { if (rec && newer(last, rec) === rec) last = rec; }
    see(project.meta);
    ['items', 'sections', 'comments', 'custom', 'reqs', 'revisions', 'spec'].forEach(function (k) {
      Object.keys(project[k] || {}).forEach(function (id) { see(project[k][id]); });
    });
    return last;
  }

  // The records of a project edited after `since` (an ISO time; '' or missing: every record),
  // newest first, for the "unsynced changes" list. Read-only. Each entry:
  //   { kind: 'meta' | 'check' | 'section' | 'comment' | 'custom' | 'req' | 'revision' | 'spec',
  //     id, item (the check a comment or check record is about, '' if none),
  //     label (what it is), detail (its state or text), at, by, deleted }
  // Values come straight from the document (untrusted): callers escape them.
  function changesSince(project, since, templates) {
    var out = [], index = {}, cut = function (t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    since = since || '';
    try { index = checkIndex(project, templates || []); } catch (e) { /* no checklists: ids stand in */ }
    var secTitle = {};
    Object.keys(index).forEach(function (k) { var s = index[k].section; if (s && s.id && !secTitle[s.id]) secTitle[s.id] = cut(s.title, 120); });
    function checkText(id) { var c = id && index[id]; return c ? cut(c.text, 120) : String(id || ''); }
    function add(kind, rec, id, item, label, detail) {
      if (!rec || typeof rec !== 'object') return;
      var at = typeof rec.updatedAt === 'string' ? rec.updatedAt : '';
      if (since && !(at > since)) return;
      out.push({ kind: kind, id: String(id || ''), item: String(item || ''), label: label, detail: detail,
        at: at, by: typeof rec.updatedBy === 'string' ? rec.updatedBy : '', deleted: !!rec.deleted });
    }
    function each(k, fn) { var m = project[k] || {}; Object.keys(m).forEach(function (id) { fn(m[id] || {}, id); }); }
    add('meta', project.meta, project.id, '', 'Name, stage, profile, or checklists', '');
    each('items', function (r, id) {
      var st = oneOf(STATUSES, r.status, ''), res = r.resolution ? oneOf(RESOLUTIONS, r.resolution, '') : '';
      add('check', r, id, id, checkText(id), (st || 'to review') + (res ? ', ' + res : ''));
    });
    each('sections', function (r, id) { add('section', r, id, '', 'Section: ' + (secTitle[id] || String(id)), r.na ? 'set aside (N/A)' : 'back in review'); });
    each('comments', function (r, id) {
      add('comment', r, id, r.item || '', r.item ? checkText(r.item) : 'Comment on the whole review', cut(r.text, 160));
    });
    each('custom', function (r, id) { add('custom', r, id, id, cut(r.text, 120) || String(id), 'added check'); });
    each('reqs', function (r, id) { add('req', r, id, '', ((r.ref ? r.ref + ' ' : '') + cut(r.text, 120)).trim() || String(id), oneOf(REQ_VERIFY, r.verify, 'open')); });
    each('revisions', function (r, id) { add('revision', r, id, '', 'Revision ' + cut(r.label, 40), oneOf(REV_STATUS, r.status, '')); });
    each('spec', function (r, id) { add('spec', r, id, '', cut(r.title, 120) || 'Untitled section', r.deleted ? '' : 'description'); });
    return out.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  }

  var RECENT = 6;   // comments kept in summary.recent
  function projectSummary(project, templates) {
    var stats = projectStats(project, templates), meta = project.meta, checklists = {};
    var issues = { open: {}, fixed: 0, waived: 0 }, open = [];
    SEVERITIES.forEach(function (s) { issues.open[s] = 0; });
    templates.forEach(function (t) {
      if (meta.checklists.indexOf(t.id) < 0) return;
      var c = stats.per[t.id];
      checklists[t.id] = { name: t.short || t.title || t.id, total: c.total, reviewed: c.reviewed, pct: c.pct, issuesOpen: c.issuesOpen };
      checklistRows(project, t).forEach(function (g) {
        g.rows.forEach(function (r) {
          if (r.status !== 'issue' || r.auto === 'profile' || r.reference) return;
          var res = r.resolution;
          if (res) { issues[res]++; return; }
          issues.open[r.severity] = (issues.open[r.severity] || 0) + 1;
          var text = String(r.def.text || '');
          open.push({ id: r.id, severity: r.severity, text: text.length > 160 ? text.slice(0, 159) + '…' : text,
            checklist: t.short || t.title || t.id, assignee: r.state.assignee || '', ref: r.state.ref || '' });
        });
      });
    });
    var reqs = null, reqList;
    if (reqsEnabled(project)) {
      var idx = checkIndex(project, templates), q = reqStats(project, idx);
      reqs = { total: q.total, approved: q.approved, pass: q.pass, fail: q.fail, risk: q.risk, open: q.open, unlinked: q.unlinked };
      reqList = reqSummaryList(project, idx);
    }
    // summary.recent: the latest discussion (newest first), for Signoff PL's Recent discussion.
    var index = checkIndex(project, templates), cut = function (t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    var recent = liveComments(project).filter(function (c) { return !(c.item && index[c.item] && index[c.item].reference); }).slice(-RECENT).reverse().map(function (c) {
      var chk = c.item && index[c.item];
      return { id: c.id, item: c.item || '', check: chk ? cut(chk.text, 160) : '', author: c.author || '', at: c.at || '', text: cut(c.text, 400) };
    });
    var last = lastEdit(project);
    // summary.revisions: the tagged revisions in order (Signoff PL, what was built for which
    // build). Left out while there are none, so reviews without any keep their bytes.
    var revs = liveRevisions(project).map(function (r) { return { label: r.label, status: r.status, sentAt: r.fab.sentAt }; });
    var out = {
      v: 1,
      tool: C.discipline || '',
      name: meta.name, project: meta.project || '', client: meta.client || '', number: meta.board || '', revision: meta.revision || '',
      stage: meta.stage || '', archived: !!meta.archived,
      total: stats.total, reviewed: stats.reviewed, pct: stats.pct,
      checklists: checklists, issues: issues, open: open.sort(function (a, b) { return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity); }),
      reqs: reqs, reqList: reqList, recent: recent,
      at: last.updatedAt || project.createdAt || '', by: last.updatedBy || ''
    };
    if (revs.length) out.revisions = revs;
    // summary.plPart: the waiting Signoff PL Part this review was started from (From Signoff PL); PL
    // links that Part to it. Left out when there's none, so other reviews keep their bytes.
    var pp = cleanPlPart(meta.plPart);
    if (pp) out.plPart = pp;
    // summary.kind: 'assembly' when the review is of an assembly (config.assemblies, Signoff ME);
    // Signoff PL then shows it on an assembly's branch. Left out for a part, so parts keep their bytes.
    if (isAssembly(project)) out.kind = 'assembly';
    // summary.spec: the description's top-level gists and gaps (specSummary).
    var sp = specSummary(project);
    if (sp) out.spec = sp;
    return out;
  }

  // summary.reqList: every requirement that isn't deleted (deprecated ones too, flagged by
  // status), with what Signoff PL shows and links by. `state` is reqState; `issues` are the
  // linked checks with an open issue (their detail is in summary.open). Text is cut to 500.
  function reqSummaryList(project, index) {
    return liveReqs(project).map(function (q) {
      var text = String(q.text || ''), parent = reqParent(q);
      var issues = (q.links || []).filter(function (id) { var c = index[id]; return c && c.status === 'issue' && !c.resolution; });
      var out = { id: q.id, ref: q.ref || '', text: text.length > 500 ? text.slice(0, 499) + '…' : text, discipline: reqDiscipline(q),
        kind: oneOf(['shall', 'should'], q.kind, 'shall'), category: q.category || '', method: oneOf(REQ_METHODS, q.method, 'inspection'),
        status: oneOf(REQ_STATUS, q.status, 'draft'), verify: oneOf(REQ_VERIFY, q.verify, 'open'), state: reqState(q, index),
        links: (q.links || []).length, issues: issues, at: q.updatedAt || '', by: q.updatedBy || '' };
      if (parent) out.parent = { tool: 'pl', project: parent.project, id: parent.id, ref: parent.ref };
      return out;
    });
  }

  // The document as written to its repository: the stored summary replaced by a fresh one.
  // A writer without checklists (Fabcheck) keeps the stored one; the next sync here renews it.
  // Reviews grouped by the client project they belong to (meta.project, e.g. one product's
  // boards), for the sidebar: [{ name, docs }], named groups A–Z (case-insensitive, trimmed),
  // then the reviews with no project under name ''. Each group keeps the order it was given.
  function projectGroups(docs) {
    var byKey = {}, order = [];
    docs.forEach(function (d) {
      var name = String((d.meta && d.meta.project) || '').trim(), key = name.toLowerCase();
      if (!byKey[key]) { byKey[key] = { name: name, docs: [] }; order.push(key); }
      byKey[key].docs.push(d);
    });
    return order.sort(function (a, b) { return (a === '') - (b === '') || a.localeCompare(b); }).map(function (k) { return byKey[k]; });
  }

  // ── Signoff PL's waiting Parts (config.pl) ──
  // A PL Part marked as a Placeholder for this tool (source config.pl.tool, no ref) waits in this
  // tool's From Signoff PL list until a review here is started from it (meta.plPart); PL then links
  // the Part to that review (signoff_pl/assets/pl.js claimPlanned). PL files are untrusted: only
  // strings pass, cut short.
  // A review of an assembly rather than a single part: meta.kind 'assembly', offered where
  // config.assemblies is set (Signoff ME). Absent means a part.
  function isAssembly(project) { return !!(project && project.meta && project.meta.kind === 'assembly'); }

  function cleanPlPart(p) {
    if (!p || typeof p !== 'object' || typeof p.project !== 'string' || typeof p.node !== 'string' || !p.project || !p.node) return null;
    return { project: p.project.slice(0, 80), node: p.node.slice(0, 80), at: typeof p.at === 'string' ? p.at.slice(0, 40) : '' };
  }
  // One PL project file, slimmed to what the list needs: its name, the client project PL matches by
  // (its name when unset), and its live Parts waiting for `tool`, with their place in the tree.
  function plSlim(doc, tool) {
    if (!doc || typeof doc !== 'object' || !doc.meta || typeof doc.meta !== 'object' || !doc.nodes || typeof doc.nodes !== 'object') return null;
    var str = function (v, n) { return (v == null || typeof v === 'object' ? '' : String(v)).slice(0, n || 200); };
    var nodes = doc.nodes;
    function path(id) {
      var out = [], seen = {};
      for (var n = nodes[nodes[id] && nodes[id].parent]; n && typeof n === 'object' && !seen[n.id]; n = nodes[n.parent]) { seen[n.id] = 1; if (!n.deleted) out.unshift(str(n.name)); }
      return out;
    }
    var planned = Object.keys(nodes).map(function (k) { return nodes[k]; }).filter(function (n) {
      return n && typeof n === 'object' && !n.deleted && n.kind !== 'assembly' && n.source === tool && !n.ref && typeof n.id === 'string' && n.id;
    }).map(function (n) { return { node: str(n.id, 80), name: str(n.name), number: str(n.number, 80), path: path(n.id) }; });
    return { id: str(doc.id, 80), name: str(doc.meta.name), clientProject: str(doc.meta.clientProject).trim() || str(doc.meta.name).trim(),
      archived: !!doc.meta.archived || !!doc.meta.deleted, planned: planned };
  }
  // The list: every waiting Part of the live PL projects that no review here (`docs`, archived ones
  // included) was started from yet, by PL project, then place in the tree, then name.
  function plWaiting(slims, docs) {
    var taken = {}, out = [];
    (docs || []).forEach(function (d) { var pp = d && d.meta && cleanPlPart(d.meta.plPart); if (pp) taken[pp.project + '/' + pp.node] = 1; });
    (slims || []).forEach(function (s) {
      if (!s || s.archived || !s.id) return;
      (s.planned || []).forEach(function (n) {
        if (!taken[s.id + '/' + n.node]) out.push(Object.assign({ project: s.id, projectName: s.name, clientProject: s.clientProject }, n));
      });
    });
    return out.sort(function (a, b) { return a.projectName.localeCompare(b.projectName) || a.path.join('/').localeCompare(b.path.join('/')) || a.name.localeCompare(b.name); });
  }

  function withSummary(project, summarize) {
    if (!summarize) return project;
    var out = Object.assign({}, project);
    delete out.summary;
    try { out.summary = summarize(out); } catch (e) { /* no checklists yet: write without */ }
    return out;
  }

  function liveComments(project, itemId) {
    return Object.keys(project.comments).map(function (k) { return project.comments[k]; })
      .filter(function (c) { return !c.deleted && (itemId === undefined || c.item === itemId); })
      // Ties (comments made in one go, such as a Fabcheck send) by id, so the order, and the
      // summary's `recent` built from it, is the same in every browser.
      .sort(function (a, b) { return (a.at || '').localeCompare(b.at || '') || String(a.id || '').localeCompare(String(b.id || '')); });
  }

  // Notes for the next revision: comments tagged @revnotes, grouped by the check they're on.
  // Newest first: groups by their latest tagged comment, and comments within a group. A custom
  // issue whose own text carries the tag forms a group too (comments may be empty).
  var REVNOTE = /(^|[^\w@])@revnotes\b/i;
  function isRevNote(text) { return REVNOTE.test(String(text || '')); }
  function stripRevNote(text) { return String(text || '').replace(/(^|[^\w@])@revnotes\b:?/ig, '$1').replace(/[ \t]{2,}/g, ' ').trim(); }
  function revNotes(project) {
    var groups = {}, order = [];
    function group(k, at) {
      if (!groups[k]) { groups[k] = { item: k, at: at || '', comments: [] }; order.push(k); }
      return groups[k];
    }
    liveComments(project).forEach(function (c) { if (isRevNote(c.text)) group(c.item || '', c.at).comments.push(c); });
    Object.keys(project.custom || {}).forEach(function (k) {
      var c = project.custom[k];
      if (c && !c.deleted && (isRevNote(c.text) || isRevNote(c.hint))) group(k, c.createdAt || c.updatedAt);
    });
    var latest = function (g) { return String((g.comments.length ? g.comments[0].at : g.at) || ''); };
    return order.map(function (k) { groups[k].comments.reverse(); return groups[k]; })
      .sort(function (a, b) { return latest(b).localeCompare(latest(a)); });
  }

  // ── Scribe: the description (project.spec) ───────────────
  // A free-form description of the design, top level to drivers (config.spec; on in Signoff FW).
  // One record per heading section, merged like every other record, newer wins per section:
  //   project.spec[id] = { id, order, level (1–4), title, kind, body, createdAt, updatedAt, updatedBy, deleted }
  // kind is one of the tool's kinds (specKinds) or '' and places the section in the diagram. The body is plain text:
  //   [text]{q:<req id>,q:<req id>}  links text to requirements (the editor shows refs: {REQ-004})
  //   [text]{std}                    standard text: description that needs no requirement
  //   [text]{s:<section id>}         points at another section (the editor shows {#Title}); a
  //                                  pointer to an interface section counts as traced
  //   @req                           flags a sentence to become a requirement
  //   Uses: A, B                     a link line naming the sections this one uses, by title. The
  //                                  words come from config.spec.links (FW: Uses; EE: Connects and
  //                                  Supplies), and a name can carry a signal or rail: MCU (UART)
  //   Parts: U7, L1, C1–C3           the reference designators a section covers (EE)
  //   > text                         the section's gist (else its first sentence)
  //   - item                         list items; | lines are a table; ``` fences code
  // Tracing is by sentence (and list item): linked, standard, flagged, or untraced. Headings, gists,
  // Uses lines, tables, and code aren't counted. Review files are untrusted: callers escape text.
  // Kinds and link words are the tool's (config.spec.kinds, .links), read on every call so a test can
  // swap them; without them, FW's: the layers product to hardware, and Uses.
  var SPEC_DEFAULT_KINDS = ['product', 'task', 'module', 'driver', 'hardware', 'interface'];
  function specCfg() { return (C.spec && typeof C.spec === 'object') ? C.spec : {}; }
  // A tool can list its kinds, or none ("kinds": [], EE: blocks have no kinds; sections group them).
  function specKinds() {
    if (!Array.isArray(specCfg().kinds)) return SPEC_DEFAULT_KINDS;
    return specCfg().kinds.map(function (x) { return typeof x === 'string' ? x : x && x.id; }).filter(function (x) { return typeof x === 'string' && /^[a-z][a-z-]*$/.test(x); });
  }
  function specKindInfo(kind) {
    var k = (Array.isArray(specCfg().kinds) ? specCfg().kinds : []).filter(function (x) { return x && typeof x === 'object' && x.id === kind; })[0];
    return k || { id: kind };
  }
  // How a kind reads, one and many: config.spec.kinds' label and plural, else the id capitalized. A
  // few words have no plural ("Hardware", not "Hardwares").
  var SPEC_PLURALS = { hardware: 'Hardware', software: 'Software', firmware: 'Firmware', power: 'Power' };
  function specKindLabel(kind) {
    var i = specKindInfo(kind);
    return kind ? (typeof i.label === 'string' && i.label) || kind.charAt(0).toUpperCase() + kind.slice(1) : '';
  }
  function specKindPlural(kind) {
    var i = specKindInfo(kind);
    if (typeof i.plural === 'string' && i.plural) return i.plural;
    return (!i.label && SPEC_PLURALS[kind]) || specKindLabel(kind) + 's';
  }
  function specLinkWords() {
    var l = Array.isArray(specCfg().links) ? specCfg().links.filter(function (w) { return typeof w === 'string' && /^[A-Za-z][A-Za-z ]*$/.test(w); }) : [];
    return l.length ? l : ['Uses'];
  }
  // The configured spelling of a link word ('uses' -> 'Uses'), or '' when the tool has no such word.
  function specLinkWord(w) { w = String(w || '').toLowerCase(); return specLinkWords().filter(function (x) { return x.toLowerCase() === w; })[0] || ''; }
  // The link a new connection from a block of this kind makes (EE: power blocks supply).
  function specKindLink(kind) { var l = specKindInfo(kind).link; return specLinkWord(l) || specLinkWords()[0]; }
  function specLinkRe(word) { return new RegExp('^\\s*' + String(word).replace(/[^A-Za-z ]/g, '') + ':', 'i'); }
  // The link word a line starts with, or ''.
  function specLinkOf(line) { var w = specLinkWords().filter(function (x) { return specLinkRe(x).test(line); })[0]; return w || ''; }
  // "MCU (UART), Display board" -> [{ name: 'MCU', label: 'UART' }, { name: 'Display board', label: '' }]
  // Brackets at the end are a signal, rail, or detail ("MCU (flash)" is the MCU). A name in double quotes
  // may hold commas and brackets: "Sensor, ADC" (I2C), "Sensor (ADC)".
  function specLinkItems(text) {
    var parts = [], cur = '', q = false;
    String(text || '').split('').forEach(function (ch) { if (ch === '"') q = !q; if (ch === ',' && !q) { parts.push(cur); cur = ''; } else cur += ch; });
    parts.push(cur);
    return parts.map(function (t) {
      var m = /^\s*"([^"]*)"\s*(?:\(([^()]*)\))?\s*$/.exec(t);
      if (m) return { name: m[1].trim(), label: (m[2] || '').trim() };
      m = /^\s*(.*?)\s*(?:\(([^()]*)\))?\s*$/.exec(t);
      return { name: m[1], label: (m[2] || '').trim() };
    }).filter(function (x) { return x.name; });
  }
  function specLinkText(items) {
    return items.map(function (x) {
      var n = String(x.name).replace(/"/g, '');
      if (/[,()]/.test(n)) n = '"' + n + '"';
      return n + (x.label ? ' (' + x.label + ')' : '');
    }).join(', ');
  }
  // Does a link item name this title? By its name, or by its name and brackets together, so a heading
  // with brackets in its title works unquoted: Uses: Sensor (ADC) names "## Sensor (ADC)".
  function specUseFull(it) { return it.label ? it.name + ' (' + it.label + ')' : it.name; }
  function specUseIs(it, title) {
    var t = String(title || '').trim().toLowerCase();
    return !!t && (String(it.name).toLowerCase() === t || specUseFull(it).toLowerCase() === t);
  }
  // The section a link item names: a title matching the whole item first, then its name.
  function specUseId(ctx, it) { return ctx.titles[specUseFull(it).toLowerCase()] || ctx.titles[String(it.name).toLowerCase()] || ''; }
  var SPEC_TAG = /(^|[^\w@])@req\b:?/i;
  // Words that end in a full stop without ending the sentence. The strong ones never end one ("e.g.
  // Linux"); the weak ones are often a sentence's last word ("above 22 V. The pump …", "etc. The"), so
  // they hold the sentence together only before a lowercase word or a number ("No. 4", "rev. B",
  // "ref. REQ-004").
  var SPEC_ABBR_STRONG = /^(e\.g|i\.e|vs|cf|viz|approx|incl|al)$/i;
  var SPEC_ABBR_WEAK = /^(etc|min|max|no|nos|fig|figs|ref|refs|rev|ver|v|esp|resp|ca|eq|sec|secs|typ|nom)$/i;
  // The longest section body a review keeps (cleanSection) and an editor may save (specTooLong).
  var SPEC_BODY_MAX = 100000;

  // ── Marks: [words]{inner} ──
  // The words may hold balanced brackets ("[It reads buf[0] first.]{std}") and `code`, whose
  // brackets and braces never count. A backtick pair is code outside a mark too, so `cfg[i]{0}` in a
  // sentence is never a mark. Marks don't cross lines. Returns [{ index, end, all, txt, inner }].
  function specCodeEnd(text, i) {
    var c = text.indexOf('`', i + 1), nl = text.indexOf('\n', i + 1);
    return c > 0 && (nl < 0 || c < nl) ? c : -1;
  }
  function specSpanAt(text, i) {
    var depth = 0, j = i, n = text.length;
    for (; j < n; j++) {
      var ch = text[j];
      if (ch === '\n') return null;
      if (ch === '`') { var c = specCodeEnd(text, j); if (c > 0) j = c; continue; }
      if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) break;
    }
    if (j >= n || text[j + 1] !== '{') return null;
    var close = text.indexOf('}', j + 2), nl = text.indexOf('\n', j + 2);
    if (close < 0 || (nl >= 0 && nl < close)) return null;
    var inner = text.slice(j + 2, close);
    if (inner.indexOf('{') >= 0) return null;
    return { index: i, end: close + 1, all: text.slice(i, close + 1), txt: text.slice(i + 1, j), inner: inner };
  }
  function specSpans(text) {
    text = String(text || '');
    var out = [], i = 0, n = text.length;
    while (i < n) {
      var ch = text[i];
      if (ch === '`') { var c = specCodeEnd(text, i); i = c > 0 ? c + 1 : i + 1; continue; }
      if (ch === '[') { var m = specSpanAt(text, i); if (m) { out.push(m); i = m.end; continue; } }
      i++;
    }
    return out;
  }
  // The text with each mark replaced by fn(all, txt, inner) (as String.replace with the old regex).
  function specSpanReplace(text, fn) {
    text = String(text || '');
    var out = '', at = 0;
    specSpans(text).forEach(function (m) { out += text.slice(at, m.index) + fn(m.all, m.txt, m.inner); at = m.end; });
    return out + text.slice(at);
  }
  // A mark that didn't parse: "]{" left in the text outside marks and code ("[a]{std", "[x]{a{b}").
  function specBrokenIn(plain) {
    return /\]\{/.test(String(plain || '').replace(/`[^`\n]*`/g, ''));
  }
  // Editor text's marks that don't parse, outside code fences: [{ line (from 1), heading, text }], for
  // the editors to list while writing.
  function specBrokenMarks(text) {
    var out = [], fence = false, heading = '';
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(function (l, i) {
      if (/^\s*```/.test(l)) { fence = !fence; return; }
      if (fence) return;
      var h = specHeading(l);
      if (h) { heading = h.title; return; }
      // Where it breaks: the first "]{" outside marks and code, shown from the "[" before it.
      var blank = function (m) { return new Array(m.length + 1).join(' '); };
      var at = specSpanReplace(l.replace(/`[^`\n]*`/g, blank), blank).indexOf(']{');
      if (at < 0) return;
      var from = Math.max(0, l.lastIndexOf('[', at)), to = Math.min(l.length, Math.max(at + 24, from + 80));
      out.push({ line: i + 1, heading: heading, text: (from > 0 ? '…' : '') + l.slice(from, to).trim() + (to < l.length ? '…' : '') });
    });
    return out;
  }

  function cleanSection(r) {
    var lv = parseInt(r.level, 10);
    return { id: String(r.id), order: typeof r.order === 'number' && isFinite(r.order) ? r.order : 0,
      level: lv >= 1 && lv <= 4 ? lv : 1, title: String(r.title == null ? '' : r.title).slice(0, 200),
      kind: oneOf(specKinds(), r.kind, ''), body: String(r.body == null ? '' : r.body).slice(0, SPEC_BODY_MAX),
      createdAt: r.createdAt || '', updatedAt: r.updatedAt || '', updatedBy: r.updatedBy || '',
      conflictOf: typeof r.conflictOf === 'string' ? r.conflictOf.slice(0, 80) : '',
      // Where the block sits in the flow diagram, once someone has arranged it (else laid out).
      pos: specPos(r.pos) };
  }
  function specPos(v) {
    if (!v || typeof v !== 'object') return null;
    var x = Number(v.x), y = Number(v.y);
    return isFinite(x) && isFinite(y) ? { x: Math.max(-5000, Math.min(20000, Math.round(x))), y: Math.max(-5000, Math.min(20000, Math.round(y))) } : null;
  }
  // Live sections in document order, cleaned.
  function liveSpec(project) {
    var m = project.spec || {};
    return Object.keys(m).map(function (k) { return m[k]; })
      .filter(function (r) { return r && typeof r === 'object' && !r.deleted && typeof r.id === 'string' && r.id; })
      .map(cleanSection)
      .sort(function (a, b) { return a.order - b.order || (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id); });
  }
  // Stamping an edit to a section also records the versions it was built on (hist: the last five
  // updatedAt values, newest first), so a merge can tell an edit made on top of another from two
  // made at the same time (mergeSpec).
  var SPEC_HIST = 5;   // versions kept: enough to tell edits apart between syncs, small in the file
  function specStamp(rec, user) {
    rec.hist = [rec.updatedAt].concat(Array.isArray(rec.hist) ? rec.hist : []).filter(function (t) { return typeof t === 'string' && t; }).slice(0, SPEC_HIST);
    return stamp(rec, user);
  }
  // Sections merge newer-wins, but when both copies were edited from the same version (neither's
  // updatedAt is in the other's hist) the older edit is kept as a "(conflict copy)" section right
  // after it, so no text is lost. The copy's id comes from the edit it keeps, so every merge of the
  // same two copies makes the same one, once.
  // opts.since: a's sections stamped before it are known to be synced already (a is this browser's
  // copy, and nobody here has edited them since it last synced). Such a section can't be one side
  // of a conflict: it's an older version of b's, even when b moved on more than SPEC_HIST edits
  // since and its hist no longer reaches back to it (2026-11-13: a copy left in a browser for a
  // few hours split five of a co-worker's sections into conflict copies). '\uffff' marks all of a
  // as synced; '' or no opts keeps the hist test alone.
  // opts.base: { section id: specStampKey } of the version a's holder last pulled (specBase). With
  // it the merge is three-way and exact, whatever the clocks say: a section a still has as pulled
  // wasn't edited there, so b's is taken; one b still has as pulled was edited only in a, so a's is
  // taken (even if a's clock stamped it earlier); only one changed on both sides is a conflict. A
  // section the base doesn't list falls back to since, then the hist test.
  function specStampKey(r) { return r && typeof r === 'object' ? String(r.updatedAt || '') + '|' + String(r.updatedBy || '') : ''; }
  function specBase(project) {
    var out = {}, m = project && project.spec || {};
    Object.keys(m).forEach(function (k) { if (m[k] && typeof m[k] === 'object') out[k] = specStampKey(m[k]); });
    return out;
  }
  function mergeSpec(a, b, opts) {
    var out = mergeMaps(a, b), since = opts && opts.since || '', base = opts && opts.base || null;
    Object.keys(a || {}).forEach(function (k) {
      var x = a[k], y = (b || {})[k];
      if (!x || !y || x === y || typeof x !== 'object' || typeof y !== 'object') return;
      if ((x.updatedAt || '') === (y.updatedAt || '') && (x.updatedBy || '') === (y.updatedBy || '')) return;
      var known = base && Object.prototype.hasOwnProperty.call(base, k);
      if (known && specStampKey(x) === base[k]) { out[k] = y; return; }   // not edited in a
      if (known && specStampKey(y) === base[k]) { out[k] = x; return; }   // edited only in a
      if (!known) {
        if (since && (x.updatedAt || '') < since) return;
        var hx = Array.isArray(x.hist) ? x.hist : [], hy = Array.isArray(y.hist) ? y.hist : [];
        // Both sides must carry history: a section built or never edited (no hist) is the base the other
        // was edited from, so newer wins (a demo rebuilt under an open tab, sections from before hist).
        if (!hx.length || !hy.length) return;
        if (hy.indexOf(x.updatedAt) >= 0 || hx.indexOf(y.updatedAt) >= 0) return;
      }
      // Edited on both sides.
      var win = newer(x, y), lose = win === x ? y : x;
      if (lose.deleted) return;
      if (!win.deleted && String(win.body || '') === String(lose.body || '') && String(win.title || '') === String(lose.title || '') && win.kind === lose.kind && win.level === lose.level) return;
      var cid = k + '~' + tokenTag(String(lose.updatedAt) + '|' + String(lose.updatedBy));
      if (out[cid]) return;
      out[cid] = Object.assign({}, lose, { id: cid, conflictOf: k, title: String(lose.title || 'Untitled') + ' (conflict copy)',
        order: (typeof lose.order === 'number' ? lose.order : 0) + 0.001, hist: [], createdAt: lose.updatedAt || '', deleted: false });
    });
    return out;
  }

  function newSection(fields, user) {
    var s = Object.assign({ id: uid('s'), order: 0, level: 1, title: '', kind: '', body: '', createdAt: now(), deleted: false }, fields || {});
    return stamp(s, user);
  }

  // '## Control loop * task' (or '· task', or '(task)') -> { level: 2, title: 'Control loop', kind: 'task' }; null if not a heading.
  function specHeading(line) {
    var m = /^(#{1,4})\s+(.*?)\s*$/.exec(String(line || ''));
    if (!m) return null;
    var title = m[2], kind = '', k = /\s+[*·]\s*([a-z]+)$/i.exec(title) || /\s+\(([a-z]+)\)$/i.exec(title);
    if (k && specKinds().indexOf(k[1].toLowerCase()) >= 0) { kind = k[1].toLowerCase(); title = title.slice(0, k.index); }
    return { level: m[1].length, title: title.trim(), kind: kind };
  }
  function specHeadingLine(s) { return new Array(s.level + 1).join('#') + ' ' + s.title + (s.kind ? ' * ' + s.kind : ''); }

  // What a span's {…} says: requirement ids, a section id, standard, and anything else (hand-typed
  // refs the editor couldn't resolve).
  function specSpanInfo(inner) {
    var out = { reqs: [], secs: [], std: false, other: [] };
    String(inner || '').split(',').forEach(function (t) {
      t = t.trim(); if (!t) return;
      if (t.toLowerCase() === 'std') out.std = true;
      else if (/^q:/.test(t)) out.reqs.push(t.slice(2));
      else if (/^s:/.test(t)) out.secs.push(t.slice(2));
      else out.other.push(t);
    });
    return out;
  }
  // A sentence as plain words: marks unwrapped, @req taken out. A space before punctuation goes only
  // where the punctuation ends a word ("pulse @req." -> "pulse."), so "the .cfg file" keeps its space.
  function specPlain(raw) {
    return specSpanReplace(raw, function (all, txt) { return txt; }).replace(new RegExp(SPEC_TAG.source, 'ig'), '$1').replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([.!?,;:])(?=$|[\s.!?,;:)"'’”\]])/g, '$1').trim();
  }

  // Does a full stop at body[i], followed by whitespace, end a sentence? next is the first character
  // after the whitespace. Not after a strong abbreviation ("e.g."), and not after a weak one ("No.",
  // "rev.", "V.") or dotted initials ("a.k.a.", "U.S.") or an ellipsis when a lowercase word or a
  // number comes next; after a weak one, not before a single capital letter either ("rev. B"), except
  // for units ("22 V. A fault …"). Anything else ends it, even before a lowercase word, so a sentence
  // may start with an identifier ("kff is added …").
  function specStopEnds(body, s, i, next) {
    var before = body.slice(Math.max(s, i - 60), i).replace(/\]\{[^{}\n]*\}$/, '').replace(/[\])"'’”]+$/, '');
    var word = (/([A-Za-z0-9.]+)$/.exec(before) || ['', ''])[1];
    if (SPEC_ABBR_STRONG.test(word)) return false;
    var low = /[a-z]/.test(next.charAt(0)), num = /[0-9]/.test(next.charAt(0));
    var token = (/^[^\s,;:)]+/.exec(next) || [''])[0];
    if (/^(?:[A-Za-z]\.)+[A-Za-z]$/.test(word) || /\.$/.test(word)) return !(low || num);
    if (SPEC_ABBR_WEAK.test(word)) {
      if (low || num || /\d/.test(token)) return false;
      if (/^[A-Z]\.?$/.test(token) && !/^(v|min|max|sec|secs|ca|typ|nom|etc)$/i.test(word)) return false;
    }
    return true;
  }

  // Sentences in body[s, e): marks are never split, and a mark whose words end a sentence ("[… cable.]{std}
  // it …") ends it at the closing brace. See specStopEnds for full stops.
  function specSentences(body, s, e) {
    var guard = [], out = [], from = s;
    specSpans(body.slice(s, e)).forEach(function (m) { guard.push({ a: s + m.index, b: s + m.end, close: s + m.index + 1 + m.txt.length }); });
    function inSpan(i) { for (var k = 0; k < guard.length; k++) if (i >= guard[k].a && i < guard[k].b) return true; return false; }
    function spanEnd(i) {
      for (var k = 0; k < guard.length; k++) if (i === guard[k].b - 1) { var c = body[guard[k].close - 1] || ''; return /[.!?]/.test(c) ? c : ''; }
      return '';
    }
    for (var i = s; i < e; i++) {
      var ch = body[i], se = spanEnd(i);
      if (se) ch = se;
      if ((ch === '.' || ch === '!' || ch === '?') && (se || !inSpan(i))) {
        var j = i + 1;
        while (j < e && /[)"'’”]/.test(body[j])) j++;
        if (j < e && !/\s/.test(body[j])) continue;
        var k2 = j; while (k2 < e && /\s/.test(body[k2])) k2++;
        if (!se && ch === '.' && k2 < e && !specStopEnds(body, s, i, body.slice(k2, Math.min(e, k2 + 40)))) continue;
        // A question or exclamation mark before a lowercase word is inside the sentence: a quoted
        // string ('logs ("RELAY ON!") when …').
        if (!se && ch !== '.' && k2 < e && /[a-z]/.test(body[k2])) continue;
        out.push([from, j]); from = j;
      }
    }
    if (from < e) out.push([from, e]);
    return out.map(function (r) {
      var a = r[0], b = r[1];
      while (a < b && /\s/.test(body[a])) a++;
      while (b > a && /\s/.test(body[b - 1])) b--;
      return [a, b];
    }).filter(function (r) { return r[1] > r[0]; });
  }

  // Lookups for resolving links: live requirements by id and by ref, sections by id and by title.
  function specContext(project) {
    var reqs = {}, refs = {}, dupRef = {}, secs = {}, titles = {};
    liveReqs(project).forEach(function (q) {
      reqs[q.id] = q;
      var r = String(q.ref || '').toLowerCase(); if (!r) return;
      if (refs[r] && refs[r] !== q.id) dupRef[r] = 1; else refs[r] = q.id;
    });
    Object.keys(dupRef).forEach(function (r) { delete refs[r]; });
    liveSpec(project).forEach(function (s) { secs[s.id] = s; var t = s.title.toLowerCase(); if (t && !titles[t]) titles[t] = s.id; });
    return { reqs: reqs, refs: refs, secs: secs, titles: titles };
  }

  // One sentence: its inline tokens and state.
  function specUnit(body, a, b, ctx) {
    var raw = body.slice(a, b), tokens = [], reqs = [], missing = [], std = false, iface = false, last = 0, plain = '';
    function text(t) {
      plain += t;
      var re = new RegExp(SPEC_TAG.source, 'ig'), mm, at = 0;
      while ((mm = re.exec(t))) {
        var tagAt = mm.index + mm[1].length;
        if (tagAt > at) tokens.push({ t: 'text', text: t.slice(at, tagAt) });
        tokens.push({ t: 'tag' }); at = tagAt + mm[0].length - mm[1].length;
      }
      if (at < t.length) tokens.push({ t: 'text', text: t.slice(at) });
    }
    specSpans(raw).forEach(function (m) {
      if (m.index > last) text(raw.slice(last, m.index));
      var info = specSpanInfo(m.inner), ids = [], secs = [], gone = [];
      info.reqs.forEach(function (id) { if (ctx.reqs[id]) ids.push(id); else gone.push(id); });
      info.other.forEach(function (t) {
        var low = t.toLowerCase();
        if (low.charAt(0) === '#' && ctx.titles[low.slice(1).trim()]) secs.push(ctx.titles[low.slice(1).trim()]);
        else if (ctx.refs[low]) ids.push(ctx.refs[low]);
        else gone.push(t);
      });
      info.secs.forEach(function (id) { if (ctx.secs[id]) secs.push(id); else gone.push(id); });
      secs.forEach(function (id) { if (ctx.secs[id].kind === 'interface') iface = true; });
      if (info.std) std = true;
      ids.forEach(function (id) { if (reqs.indexOf(id) < 0) reqs.push(id); });
      gone.forEach(function (t) { missing.push(t); });
      tokens.push({ t: 'span', text: m.txt, reqs: ids, secs: secs, std: info.std, missing: gone });
      last = m.end;
    });
    if (last < raw.length) text(raw.slice(last));
    var tag = SPEC_TAG.test(raw), words = specPlain(raw), note = SPEC_NOTE.test(words);
    // A review note ("Check: …", Chris 2026-11-09) is neither a gap nor a description: @req still wins,
    // so the inbox stays complete.
    var state = tag ? 'tag' : note ? 'note' : reqs.length || iface ? 'linked' : std ? 'std' : 'untraced';
    // broken: a mark in it didn't parse, so its words read as typed (shown in the margin and Edit all).
    return { start: a, end: b, raw: raw, tokens: tokens, reqs: reqs, missing: missing, std: std, tag: tag, note: note, state: state, text: words, broken: specBrokenIn(plain) };
  }
  // A review note: a sentence or list item that starts "Check:", a doubt or question for the review.
  // Counted on its own (not unlinked), not a gap in the diagram, and resolved by taking it out.
  var SPEC_NOTE = /^check:/i;

  // A table row's cells: the bars at its ends dropped, split at every bar but an escaped one (\| is a bar
  // inside a cell).
  function specCells(line) {
    var t = String(line || '').trim().replace(/^\|/, '');
    if (/\|$/.test(t) && !/\\\|$/.test(t)) t = t.slice(0, -1);
    var cells = [], cur = '';
    for (var i = 0; i < t.length; i++) {
      if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; }
      else if (t[i] === '|') { cells.push(cur.trim()); cur = ''; }
      else cur += t[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  // A section body as blocks: p and li (with sentence units), gist, uses, table (rows with marks are
  // units), code.
  function specBlocks(body, ctx) {
    body = String(body || '');
    var out = [], lines = [], pos = 0;
    body.split('\n').forEach(function (l) { lines.push({ s: pos, e: pos + l.length, t: l }); pos += l.length + 1; });
    var para = null, i = 0;
    function endPara() {
      if (!para) return;
      out.push({ type: 'p', start: para.s, end: para.e, units: specSentences(body, para.s, para.e).map(function (r) { return specUnit(body, r[0], r[1], ctx); }) });
      para = null;
    }
    while (i < lines.length) {
      var L = lines[i], t = L.t, trim = t.trim();
      if (/^```/.test(trim)) {
        endPara();
        var code = [], j = i + 1;
        while (j < lines.length && !/^```/.test(lines[j].t.trim())) code.push(lines[j++].t);
        out.push({ type: 'code', text: code.join('\n') }); i = j + 1; continue;
      }
      if (!trim) { endPara(); i++; continue; }
      if (/^\|/.test(trim)) {
        endPara();
        var rows = [], rowUnits = [], tunits = [];
        while (i < lines.length && /^\|/.test(lines[i].t.trim())) {
          var R = lines[i], r = specCells(R.t);
          if (!r.every(function (c) { return /^:?-{2,}:?$/.test(c); })) {
            // A row with a mark (a link to a requirement, std, a pointer) is one unit, like a sentence:
            // an ICD row can trace its requirement. Rows without marks aren't counted.
            var ru = null;
            if (specSpans(R.t).length) {
              var ra = R.s + (R.t.length - R.t.replace(/^\s+/, '').length), rb = R.e;
              while (rb > ra && /\s/.test(body[rb - 1])) rb--;
              ru = specUnit(body, ra, rb, ctx);
              ru.row = true; ru.text = r.map(specPlain).filter(Boolean).join(' · ');
              tunits.push(ru);
            }
            rows.push(r); rowUnits.push(ru);
          }
          i++;
        }
        out.push({ type: 'table', rows: rows, rowUnits: rowUnits, units: tunits }); continue;
      }
      var lw = specLinkOf(trim);
      if (lw) {
        endPara();
        var items = specLinkItems(trim.replace(specLinkRe(lw), ''));
        out.push({ type: 'uses', word: lw, items: items, names: items.map(function (x) { return x.name; }) }); i++; continue;
      }
      var pm = /^parts:\s*(.*)$/i.exec(trim);
      if (pm) {
        endPara();
        out.push({ type: 'parts', items: pm[1].split(',').map(function (n) { return n.trim(); }).filter(Boolean) }); i++; continue;
      }
      if (/^>\s?/.test(trim)) {
        endPara();
        var gs = L.s + t.indexOf('>') + 1;
        out.push({ type: 'gist', text: specPlain(body.slice(gs, L.e)) }); i++; continue;
      }
      var lm = /^(\s*[-*]\s+)/.exec(t);
      if (lm) {
        endPara();
        var a = L.s + lm[1].length, b = L.e;
        while (b > a && /\s/.test(body[b - 1])) b--;
        out.push({ type: 'li', start: a, end: b, units: b > a ? [specUnit(body, a, b, ctx)] : [] }); i++; continue;
      }
      // A "Check:" line starts its own paragraph, so notes typed one per line stay apart.
      if (para && SPEC_NOTE.test(trim)) endPara();
      if (!para) para = { s: L.s + (t.length - t.replace(/^\s+/, '').length), e: L.e };
      else para.e = L.e;
      i++;
    }
    endPara();
    return out;
  }

  // Every section with its blocks, counts, gist, and the sections it uses; the requirements each
  // links; flagged sentences; and the requirements nothing describes.
  function specAnalysis(project) {
    var ctx = specContext(project), secs = liveSpec(project), use = {}, tags = [];
    var totals = { sections: secs.length, units: 0, linked: 0, std: 0, tag: 0, untraced: 0, note: 0 };
    var out = secs.map(function (s, si) {
      var blocks = specBlocks(s.body, ctx), c = { linked: 0, std: 0, tag: 0, untraced: 0, note: 0 }, gist = '', uses = [], links = [], edges = [], parts = [], notes = [];
      blocks.forEach(function (bk) {
        if (bk.type === 'gist' && !gist) gist = bk.text;
        if (bk.type === 'uses') bk.items.forEach(function (it) {
          var id = specUseId(ctx, it);
          if (!id || id === s.id) return;
          if (uses.indexOf(id) < 0) uses.push(id);
          // Brackets that are part of the title ("Sensor (ADC)") aren't a signal name.
          edges.push({ id: id, word: bk.word, label: it.label && ctx.titles[specUseFull(it).toLowerCase()] !== id ? it.label : '' });
        });
        if (bk.type === 'parts') bk.items.forEach(function (n) { if (parts.indexOf(n) < 0) parts.push(n); });
        (bk.units || []).forEach(function (u) {
          c[u.state]++; totals[u.state]++; totals.units++;
          if (u.state === 'note') { notes.push(u); return; }   // a note's links don't describe its requirements
          u.reqs.forEach(function (id) { (use[id] = use[id] || []).push({ sec: s.id, start: u.start, text: u.text }); if (links.indexOf(id) < 0) links.push(id); });
          if (u.tag) tags.push({ sec: s.id, start: u.start, text: u.text, reqs: u.reqs.slice() });
        });
      });
      if (!gist) {
        var first = [];
        blocks.forEach(function (bk) { if (bk.type === 'p' || bk.type === 'li') bk.units.forEach(function (u) { if (u.state !== 'note') first.push(u); }); });
        gist = first.length ? first[0].text : '';
      }
      // uses: ids of the sections its link lines name; edges: each with its link word and label.
      return { sec: s, index: si, blocks: blocks, counts: c, gaps: c.untraced + c.tag, notes: notes, gist: gist, uses: uses, edges: edges, parts: parts, links: links };
    });
    // Parents: the nearest earlier section with a smaller level.
    out.forEach(function (x, i) {
      x.parent = '';
      for (var j = i - 1; j >= 0; j--) if (out[j].sec.level < x.sec.level) { x.parent = out[j].sec.id; break; }
    });
    // Linked requirements per section: those in the section's own text plus its tags' section links.
    tags.forEach(function (t) {
      var x = out.filter(function (y) { return y.sec.id === t.sec; })[0];
      t.sectionReqs = x ? x.links.slice() : [];
    });
    var undescribed = liveReqs(project).filter(function (q) { return q.status !== 'deprecated' && !use[q.id]; }).map(function (q) { return q.id; });
    return { sections: out, totals: totals, uses: use, tags: tags, undescribed: undescribed, ctx: ctx };
  }

  // Edit the sentence at body[start, end) (from specBlocks):
  //   link id: add a requirement link (into its existing link, else around the whole sentence), drop @req
  //   unlink id: remove that requirement from its links
  //   std true|false: mark or unmark as standard text
  //   tag true|false: add or remove @req
  //   phrase { id, text }: link just those words (as shown, without marks) to a requirement: into a
  //        link whose words they are, else around their first place outside other marks; drops @req.
  //        Returns the body unchanged when the words aren't found that way.
  function specEdit(body, start, end, op, arg) {
    body = String(body || '');
    var raw = body.slice(start, end), out = raw;
    function stripTag(t) { return t.replace(new RegExp(SPEC_TAG.source, 'ig'), '$1').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.!?,;:])$/, '$1').trim(); }
    function wrap(t, inner) {
      var m = /^([\s\S]*?)([.!?:;,]*)$/.exec(t);
      return '[' + m[1] + ']{' + inner + '}' + m[2];
    }
    function eachSpan(fn) {
      return specSpanReplace(out, function (all, txt, inner) {
        var toks = inner.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        toks = fn(toks);
        return toks === null ? all : toks.length ? '[' + txt + ']{' + toks.join(',') + '}' : txt;
      });
    }
    // A sentence with a mark that didn't parse is left alone: wrapping it would make another.
    if (op !== 'tag' && op !== 'unlink' && specBrokenIn(specSpanReplace(raw, function () { return ''; }))) return body;
    var refSpan = specSpans(raw).some(function (sp) { return !/^\s*std\s*$/i.test(sp.inner); });
    // A table row: never wrapped or flagged (that would break its cells); a link goes into its first
    // mark, standard is set on its marks, and a phrase stays inside one cell.
    if (/^\s*\|/.test(raw)) {
      if (op === 'tag' || (op !== 'unlink' && !specSpans(raw).length)) return body;
      if (op === 'phrase' && String(arg && arg.text || '').indexOf('|') >= 0) return body;
      if (op === 'link' && !refSpan) {
        var first = true;
        out = eachSpan(function (toks) { if (!first) return null; first = false; return toks.filter(function (x) { return x.toLowerCase() !== 'std'; }).concat(['q:' + arg]); });
        return body.slice(0, start) + out + body.slice(end);
      }
    }
    if (op === 'link') {
      out = stripTag(out);
      if (refSpan) {
        var done = false;
        out = eachSpan(function (toks) {
          if (done || (toks.length === 1 && toks[0].toLowerCase() === 'std')) return null;
          done = true;
          return toks.filter(function (x) { return x.toLowerCase() !== 'std'; }).concat(toks.indexOf('q:' + arg) < 0 ? ['q:' + arg] : []);
        });
      } else {
        out = eachSpan(function (toks) { return toks.filter(function (x) { return x.toLowerCase() !== 'std'; }); });
        out = wrap(out, 'q:' + arg);
      }
    } else if (op === 'unlink') {
      out = eachSpan(function (toks) { return toks.filter(function (x) { return x !== 'q:' + arg && x.toLowerCase() !== String(arg).toLowerCase(); }); });
    } else if (op === 'std') {
      out = eachSpan(function (toks) { return toks.filter(function (x) { return x.toLowerCase() !== 'std'; }); });
      if (arg) {
        out = stripTag(out);
        if (specSpans(out).length) { var once = false; out = eachSpan(function (toks) { if (once) return null; once = true; return toks.concat(['std']); }); }
        else out = wrap(out, 'std');
      }
    } else if (op === 'phrase') {
      var want = String(arg && arg.text || '').replace(/\s+/g, ' ').trim(), qid = 'q:' + (arg && arg.id);
      if (!want) return body;
      var hit = false;
      // Words that are a link's own text: add to that link.
      out = specSpanReplace(out, function (all, txt, inner) {
        if (hit || txt.replace(/\s+/g, ' ').trim() !== want) return all;
        hit = true;
        var toks = inner.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x && x.toLowerCase() !== 'std'; });
        if (toks.indexOf(qid) < 0) toks.push(qid);
        return '[' + txt + ']{' + toks.join(',') + '}';
      });
      if (!hit) {
        // Else the first place outside every mark.
        var guard = specSpans(out).map(function (gm) { return [gm.index, gm.end]; });
        var from = 0, at = -1;
        while ((at = out.indexOf(want, from)) >= 0) {
          var a0 = at, b0 = at + want.length;
          if (!guard.some(function (g) { return a0 < g[1] && b0 > g[0]; })) break;
          from = at + 1;
        }
        if (at < 0) return body;
        out = out.slice(0, at) + '[' + want + ']{' + qid + '}' + out.slice(at + want.length);
      }
      out = stripTag(out);
    } else if (op === 'tag') {
      out = stripTag(out);
      if (arg) { var pm = /^([\s\S]*?)([.!?]*)$/.exec(out); out = pm[1] + ' @req' + pm[2]; }
    }
    return body.slice(0, start) + out + body.slice(end);
  }

  // Taking the sentence at body[start, end) out (resolving a review note): when it's all its line has (a
  // list item, or a note on a line of its own) the line goes with its newline; else the sentence goes
  // with the spaces after it (or before it, at the end of a line).
  function specRemoveUnit(body, start, end) {
    body = String(body || '');
    var ls = body.lastIndexOf('\n', start - 1) + 1, le = body.indexOf('\n', end);
    if (le < 0) le = body.length;
    var line = body.slice(ls, le), out;
    if (line.replace(/^\s*(?:[-*]\s+)?/, '').trim() === body.slice(start, end).trim()) {
      out = body.slice(0, ls) + body.slice(le < body.length ? le + 1 : le);
    } else {
      var a = start, b = end;
      while (b < le && /[ \t]/.test(body[b])) b++;
      if (b === end || b === le) while (a > ls && /[ \t]/.test(body[a - 1])) a--;
      out = body.slice(0, a) + body.slice(b);
    }
    return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
  }

  // Bodies as the editor shows them (requirement refs and section titles) and back.
  function specToEditor(body, ctx) {
    return specSpanReplace(body, function (all, txt, inner) {
      return '[' + txt + ']{' + inner.split(',').map(function (t) {
        t = t.trim();
        if (/^q:/.test(t) && ctx.reqs[t.slice(2)]) { var q = ctx.reqs[t.slice(2)], r = String(q.ref || ''); return r && ctx.refs[r.toLowerCase()] === q.id ? r : t; }
        if (/^s:/.test(t) && ctx.secs[t.slice(2)]) { var s = ctx.secs[t.slice(2)]; return s.title && ctx.titles[s.title.toLowerCase()] === s.id ? '#' + s.title : t; }
        return t;
      }).join(',') + '}';
    });
  }
  function specFromEditor(text, ctx) {
    return specSpanReplace(text, function (all, txt, inner) {
      var seen = {};
      return '[' + txt + ']{' + inner.split(',').map(function (t) {
        t = t.trim(); var low = t.toLowerCase();
        if (low === 'std' || /^[qs]:/.test(t)) return low === 'std' ? 'std' : t;
        if (low.charAt(0) === '#' && ctx.titles[low.slice(1).trim()]) return 's:' + ctx.titles[low.slice(1).trim()];
        if (ctx.refs[low]) return 'q:' + ctx.refs[low];
        return specRange(t, ctx) || t;
      }).join(',').split(',').filter(function (t) { if (!t || seen[t]) return false; seen[t] = 1; return true; }).join(',') + '}';
    });
  }
  // "REQ-044..REQ-063" (or "REQ-044..063", or an en dash between): every requirement of that run that
  // exists, as ids ("q:a,q:b"), so it's written out on save. None existing keeps it as typed, and it
  // shows as not found. Runs over 500 are left alone.
  function specRange(t, ctx) {
    var m = /^([A-Za-z][A-Za-z_-]*?)(\d+)\s*(?:\.\.|–)\s*([A-Za-z][A-Za-z_-]*?)?(\d+)$/.exec(String(t || '').trim());
    if (!m || (m[3] && m[3].toLowerCase() !== m[1].toLowerCase())) return '';
    var a = parseInt(m[2], 10), b = parseInt(m[4], 10), out = [];
    if (b < a || b - a > 500) return '';
    for (var n = a; n <= b; n++) {
      var num = String(n); while (num.length < m[2].length) num = '0' + num;
      var id = ctx.refs[(m[1] + num).toLowerCase()];
      if (id) out.push('q:' + id);
    }
    return out.join(',');
  }

  // Text cut at headings (outside code fences): [{ heading: {level, title, kind} | null, body }].
  function specSplit(text) {
    var chunks = [], cur = { heading: null, lines: [] }, fence = false;
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(function (l) {
      if (/^\s*```/.test(l)) fence = !fence;
      var h = !fence && specHeading(l);
      if (h) { chunks.push(cur); cur = { heading: h, lines: [] }; } else cur.lines.push(l);
    });
    chunks.push(cur);
    return chunks.map(function (c) { return { heading: c.heading, body: c.lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '') }; })
      .filter(function (c) { return c.heading || c.body.trim(); });
  }

  // Saving the editor's text for one section (id, or null for a new one at the end): the records
  // to write. The first chunk updates the section (keeping its heading if the text has none);
  // further headings become new sections right after it. Empty text deletes the section.
  function specSave(project, id, text, user) {
    var secs = liveSpec(project), idx = -1;
    secs.forEach(function (s, i) { if (s.id === id) idx = i; });
    var cur = idx >= 0 ? (project.spec || {})[id] : null;
    var chunks = specSplit(text);
    if (!chunks.length) return cur ? [specStamp(Object.assign({}, cur, { deleted: true }), user)] : [];
    var lo = idx >= 0 ? secs[idx].order : secs.length ? secs[secs.length - 1].order : 0;
    var hi = idx >= 0 && idx + 1 < secs.length ? secs[idx + 1].order : lo + chunks.length + 1;
    var step = (hi - lo) / (chunks.length + (cur ? 0 : 1));
    var recs = chunks.map(function (c, i) {
      var h = c.heading || (i === 0 && cur ? { level: cleanSection(cur).level, title: cleanSection(cur).title, kind: cleanSection(cur).kind } : { level: 1, title: 'Untitled', kind: '' });
      var fields = { level: h.level, title: h.title, kind: h.kind, body: c.body };
      if (i === 0 && cur) return Object.assign({}, cur, fields);
      return newSection(Object.assign(fields, { order: lo + step * (cur ? i : i + 1) }), user);
    });
    // Resolve refs and #titles against the document as it will be.
    var view = Object.assign({}, project, { spec: Object.assign({}, project.spec || {}) });
    recs.forEach(function (r) { view.spec[r.id] = r; });
    var ctx = specContext(view);
    recs = recs.map(function (r) { r.body = specFromEditor(r.body, ctx); return specStamp(r, user); });
    // Renaming the section renames it in the other sections' Uses lines.
    var was = cur && cleanSection(cur).title;
    if (cur && recs[0] && !recs[0].deleted && was && was !== recs[0].title) {
      var mine = {}; recs.forEach(function (r) { mine[r.id] = 1; });
      secs.forEach(function (s) {
        if (mine[s.id]) return;
        var rawBody = specRawBody(project, s.id), b = specRenameUses(rawBody, was, recs[0].title);
        if (b !== rawBody) recs.push(specStamp(Object.assign({}, project.spec[s.id], { body: b }), user));
      });
    }
    return recs;
  }
  // A section's body as stored, not cut to SPEC_BODY_MAX: what a rewrite of one line starts from, so
  // renaming a block never shortens a long section that names it.
  function specRawBody(project, id) { var r = (project.spec || {})[id]; return String(r && r.body != null ? r.body : ''); }
  // Records an editor is about to write whose text is longer than a section may be (they'd be cut when
  // read): [{ id, title, length }]. The editors refuse to save them.
  function specTooLong(recs) {
    return (recs || []).filter(function (r) { return r && !r.deleted && String(r.body || '').length > SPEC_BODY_MAX; })
      .map(function (r) { return { id: r.id, title: String(r.title || 'Untitled'), length: String(r.body).length }; });
  }

  // The description as a Markdown document to share outside Signoff: headings with their kind,
  // gists as quotes, links as "words [REQ-004]", pointers and standard marks dropped, Uses in
  // italics, then the requirements with where each is described.
  function specMarkdown(project) {
    var a = specAnalysis(project), m = project.meta || {}, out = [];
    var ref = function (id) { var q = a.ctx.reqs[id]; return q ? q.ref || '?' : ''; };
    function inline(raw) {
      return specSpanReplace(raw, function (all, txt, inner) {
        var info = specSpanInfo(inner), refs = info.reqs.map(ref).filter(Boolean).concat(info.other.filter(function (t) { return t.charAt(0) !== '#' && a.ctx.refs[t.toLowerCase()]; }));
        return txt + (refs.length ? ' [' + refs.join(', ') + ']' : '');
      });
    }
    out.push('# ' + (m.name || 'Description'), '');
    var sub = [m.project, m.board, m.revision && 'Rev ' + m.revision].filter(Boolean).join(' · ');
    if (sub) out.push(sub, '');
    a.sections.forEach(function (x) {
      var s = x.sec;
      out.push(new Array(Math.min(6, s.level + 1) + 1).join('#') + ' ' + (s.title || 'Untitled') + (s.kind ? ' (' + s.kind + ')' : ''), '');
      var fence = false, lines = String(s.body || '').split('\n').map(function (l) {
        if (/^\s*```/.test(l)) { fence = !fence; return l; }
        if (fence) return l;
        var lw2 = specLinkOf(l);
        if (lw2) return '*' + lw2 + ': ' + l.replace(specLinkRe(lw2), '').trim() + '*';
        if (/^\s*parts:/i.test(l)) return '*Parts: ' + l.replace(/^\s*parts:\s*/i, '') + '*';
        return inline(l);
      });
      out.push(lines.join('\n').replace(/\s+$/, ''), '');
    });
    var reqs = liveReqs(project).filter(function (q) { return q.status !== 'deprecated'; });
    if (reqs.length) {
      out.push('## Requirements', '', '| ID | Requirement | Described in |', '| --- | --- | --- |');
      reqs.forEach(function (q) {
        var where = (a.uses[q.id] || []).map(function (w) { return a.ctx.secs[w.sec].title; }).filter(function (t, i, all) { return all.indexOf(t) === i; });
        out.push('| ' + [q.ref || '', String(q.text || '').replace(/\|/g, '\\|'), where.join(', ') || 'Not described'].join(' | ') + ' |');
      });
      out.push('');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  // Comments tagged @req (on a check, a requirement, or the whole review), oldest first: they wait
  // in Scribe's Requirements to make list beside the flagged sentences, until handled
  // (reqDone: the comment's words are left as written).
  function specCommentTags(project) {
    return liveComments(project).filter(function (c) { return !c.reqDone && SPEC_TAG.test(String(c.text || '')); }).map(function (c) {
      return { id: c.id, item: c.item || '', author: c.author || '', at: c.at || '', text: specPlain(c.text) };
    });
  }

  // A section's gist (> line) or Uses line, set, replaced, or (empty value) removed. A gist goes
  // first, a Uses line last. Lines inside code fences are left alone.
  // which: 'gist', or a link word ('uses', 'connects', 'supplies': the tool's own spelling is written).
  var SPEC_GIST = /^\s*>\s?/;
  function specLineRe(which) { return which === 'gist' ? SPEC_GIST : specLinkRe(specLinkWord(which) || which); }
  function specLineIndex(lines, which) {
    var fence = false, re = specLineRe(which);
    for (var i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
      if (!fence && re.test(lines[i])) return i;
    }
    return -1;
  }
  function specSetLine(body, which, value) {
    var lines = String(body || '').split('\n'), i = specLineIndex(lines, which);
    value = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    var word = which === 'gist' ? '' : specLinkWord(which) || String(which).charAt(0).toUpperCase() + String(which).slice(1);
    var line = value ? (which === 'gist' ? '> ' : word + ': ') + value : null;
    if (i >= 0) { if (line) lines[i] = line; else lines.splice(i, 1); }
    else if (line) {
      if (which === 'gist') lines.unshift(line);
      else { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); lines.push(line); }
    }
    return lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
  }
  // The names on a section's link line (word: a link word; the tool's first by default), signal or
  // rail names left off; specUsesItems keeps them.
  function specUsesItems(body, word) {
    word = word || specLinkWords()[0];
    var lines = String(body || '').split('\n'), i = specLineIndex(lines, word);
    return i < 0 ? [] : specLinkItems(lines[i].replace(specLineRe(word), ''));
  }
  function specUsesNames(body, word) { return specUsesItems(body, word).map(function (x) { return x.name; }); }
  // Uses lines name sections by title: a renamed heading is renamed in every Uses line too.
  function specRenameUses(body, from, to) {
    var key = String(from || '').trim().toLowerCase();
    if (!key) return String(body || '');
    var fence = false;
    return String(body || '').split('\n').map(function (l) {
      if (/^\s*```/.test(l)) { fence = !fence; return l; }
      var w = fence ? '' : specLinkOf(l);
      if (!w) return l;
      var items = specLinkItems(l.replace(specLinkRe(w), ''));
      if (!items.some(function (x) { return specUseIs(x, key); })) return l;
      return w + ': ' + specLinkText(items.map(function (x) { return specUseIs(x, key) ? { name: to, label: x.name.toLowerCase() === key ? x.label : '' } : x; }));
    }).join('\n');
  }
  // Renaming a section (from the diagram): the records to write, its own and every section whose
  // Uses line named it.
  function specRename(project, id, title, user) {
    var cur = (project.spec || {})[id];
    title = String(title || '').replace(/\s+/g, ' ').trim();
    if (!cur || !title) return [];
    var from = cleanSection(cur).title;
    if (from === title) return [];
    var out = [specStamp(Object.assign({}, cur, { title: title }), user)];
    liveSpec(project).forEach(function (s) {
      if (s.id === id) return;
      var rawBody = specRawBody(project, s.id), b = specRenameUses(rawBody, from, title);
      if (b !== rawBody) out.push(specStamp(Object.assign({}, project.spec[s.id], { body: b }), user));
    });
    return out;
  }
  // A new block from the diagram: { title, kind, gist, parent (the section that uses it) }. It goes
  // after the last section of its kind (at that level), else under its parent, else at the end;
  // the parent's Uses line gains it. Returns the records to write, the new section first.
  function specAddBlock(project, f, user) {
    var secs = liveSpec(project), title = String(f.title || '').replace(/\s+/g, ' ').trim();
    if (!title) return [];
    var kind = oneOf(specKinds(), f.kind, ''), parent = f.parent && (project.spec || {})[f.parent] ? cleanSection(project.spec[f.parent]) : null;
    function subtreeEnd(i) { var lv = secs[i].level, j = i + 1; while (j < secs.length && secs[j].level > lv) j++; return j - 1; }
    var at = -1, level = secs.length ? 2 : 1, i;
    for (i = secs.length - 1; i >= 0; i--) if (kind && secs[i].kind === kind) { at = subtreeEnd(i); level = secs[i].level; break; }
    if (at < 0 && parent) for (i = 0; i < secs.length; i++) if (secs[i].id === parent.id) { at = subtreeEnd(i); level = Math.min(4, secs[i].level + 1); break; }
    if (at < 0) at = secs.length - 1;
    var lo = at >= 0 ? secs[at].order : 0, hi = at + 1 < secs.length ? secs[at + 1].order : lo + 2;
    var rec = newSection({ order: (lo + hi) / 2, level: level, title: title, kind: kind, body: specSetLine('', 'gist', f.gist || '') }, user);
    var out = [rec];
    if (parent) {
      var lword = specKindLink(parent.kind), pbody = specRawBody(project, parent.id), items = specUsesItems(pbody, lword);
      if (!items.some(function (x) { return specUseIs(x, title); })) {
        out.push(specStamp(Object.assign({}, project.spec[parent.id], { body: specSetLine(pbody, lword, specLinkText(items.concat([{ name: title, label: f.label || '' }]))) }), user));
      }
    }
    return out;
  }

  // Moving a block in the diagram: { kind, before, after } (a section id to sit before, or after with
  // its subsections). The section takes the kind; with a neighbor it moves, with the sections under
  // it, to that place in the outline at the neighbor's level. Returns the records to write.
  function specMoveBlock(project, id, f, user) {
    var secs = liveSpec(project), i = -1, k;
    for (k = 0; k < secs.length; k++) if (secs[k].id === id) i = k;
    if (i < 0) return [];
    var end = i + 1; while (end < secs.length && secs[end].level > secs[i].level) end++;
    var tree = secs.slice(i, end), inTree = {}; tree.forEach(function (s) { inTree[s.id] = 1; });
    var kind = f.kind === undefined ? secs[i].kind : oneOf(specKinds(), f.kind, '');
    var changed = {}, put = function (s, fields) { changed[s.id] = Object.assign(changed[s.id] || {}, fields); };
    if (kind !== secs[i].kind) put(secs[i], { kind: kind });
    var nb = f.before || f.after;
    if (nb && !inTree[nb]) {
      var rest = secs.filter(function (s) { return !inTree[s.id]; }), j = -1;
      for (k = 0; k < rest.length; k++) if (rest[k].id === nb) j = k;
      if (j >= 0) {
        var at = j;
        if (f.after) { at = j + 1; while (at < rest.length && rest[at].level > rest[j].level) at++; }
        var lo = at > 0 ? rest[at - 1].order : (rest.length ? rest[0].order - 1 : 0);
        var hi = at < rest.length ? rest[at].order : lo + tree.length + 1;
        var shift = rest[j].level - secs[i].level;
        tree.forEach(function (s, n) {
          var lv = Math.max(1, Math.min(4, s.level + shift)), ord = lo + (hi - lo) * (n + 1) / (tree.length + 1);
          if (ord !== s.order || lv !== s.level) put(s, { order: ord, level: lv });
        });
      }
    }
    return Object.keys(changed).map(function (sid) { return specStamp(Object.assign({}, project.spec[sid], changed[sid]), user); });
  }

  // ── Sections in the flow diagram ──
  // The outline is the hierarchy: a heading with headings under it is a section (a box in the diagram)
  // and the headings under it are its blocks. A level-1 heading with headings under it is the board
  // itself and isn't drawn.
  function specTreeEnd(secs, i) { var lv = secs[i].level, j = i + 1; while (j < secs.length && secs[j].level > lv) j++; return j; }
  // Move whole subtrees (ids, each with the headings under it) to the end of `parentId`'s subtree, one
  // level under it; with no parent, to the end of the document one level under the board (level 2 when
  // there's a level-1 heading, else 1). With `beforeId`, a heading already there at that level, they go
  // just before it instead (reordering). Orders are renumbered; only changed records come back.
  function specNest(project, ids, parentId, user, beforeId) {
    var secs = liveSpec(project), idx = {}, k;
    secs.forEach(function (s, i) { idx[s.id] = i; });
    var parent = parentId && idx[parentId] !== undefined ? secs[idx[parentId]] : null;
    // The top-most of the chosen headings (one inside another moves with it), in document order.
    var heads = ids.filter(function (id) { return idx[id] !== undefined; }).sort(function (a, b) { return idx[a] - idx[b]; });
    var take = {}, moving = [];
    heads.forEach(function (id) {
      if (take[id]) return;
      var i = idx[id], end = specTreeEnd(secs, i);
      if (parent && idx[parent.id] >= i && idx[parent.id] < end) return;   // never into itself
      var tree = secs.slice(i, end);
      tree.forEach(function (s) { take[s.id] = 1; });
      moving.push(tree);
    });
    if (!moving.length) return [];
    var rest = secs.filter(function (s) { return !take[s.id]; });
    var hasRoot = secs.some(function (s) { return s.level === 1; });
    var lvl = parent ? Math.min(4, parent.level + 1) : (hasRoot ? 2 : 1), at = rest.length;
    if (parent) { var pi = -1; for (k = 0; k < rest.length; k++) if (rest[k].id === parent.id) pi = k; at = specTreeEnd(rest, pi); }
    if (beforeId) {
      var lo = parent ? -1 : -1, hi = at;
      if (parent) for (k = 0; k < rest.length; k++) if (rest[k].id === parent.id) lo = k;
      for (k = lo + 1; k < hi; k++) if (rest[k].id === beforeId && rest[k].level === lvl) { at = k; break; }
    }
    var placed = [];
    moving.forEach(function (tree) { var shift = lvl - tree[0].level; tree.forEach(function (s) { placed.push({ s: s, level: Math.max(1, Math.min(4, s.level + shift)) }); }); });
    var order = rest.slice(0, at).map(function (s) { return { s: s, level: s.level }; }).concat(placed, rest.slice(at).map(function (s) { return { s: s, level: s.level }; }));
    var out = [];
    order.forEach(function (o, i) {
      if (o.s.order === i + 1 && o.s.level === o.level) return;
      out.push(specStamp(Object.assign({}, project.spec[o.s.id], { order: i + 1, level: o.level }), user));
    });
    return out;
  }
  // A new section around some headings (drawn in the diagram): a heading where the first of them was,
  // at its level, with them moved under it. Returns the records to write, the new section first.
  function specGroup(project, ids, title, user) {
    var secs = liveSpec(project), idx = {};
    secs.forEach(function (s, i) { idx[s.id] = i; });
    var heads = ids.filter(function (id) { return idx[id] !== undefined; }).sort(function (a, b) { return idx[a] - idx[b]; });
    title = String(title || '').replace(/\s+/g, ' ').trim();
    if (!heads.length || !title) return [];
    var first = secs[idx[heads[0]]], prev = idx[heads[0]] > 0 ? secs[idx[heads[0]] - 1].order : first.order - 1;
    var sec = newSection({ order: (prev + first.order) / 2, level: first.level, title: title, kind: '', body: '' }, user);
    var view = Object.assign({}, project, { spec: Object.assign({}, project.spec || {}) });
    view.spec[sec.id] = sec;
    var nest = specNest(view, heads, sec.id, user), mine = {};
    nest.forEach(function (r) { mine[r.id] = r; });
    return [mine[sec.id] || sec].concat(nest.filter(function (r) { return r.id !== sec.id; }));
  }
  // Ungrouping a section: the headings under it move up a level in its place; the section heading
  // goes too unless it has text of its own (then it stays, as a block, after them).
  function specUngroup(project, id, user) {
    var secs = liveSpec(project), i = -1, k;
    for (k = 0; k < secs.length; k++) if (secs[k].id === id) i = k;
    if (i < 0) return [];
    var end = specTreeEnd(secs, i), sec = secs[i], out = [];
    secs.slice(i + 1, end).forEach(function (s) { out.push(specStamp(Object.assign({}, project.spec[s.id], { level: Math.max(1, s.level - 1) }), user)); });
    if (!sec.body.trim()) out.push(specStamp(Object.assign({}, project.spec[id], { deleted: true }), user));
    else out.push(specStamp(Object.assign({}, project.spec[id], { order: (end < secs.length ? (secs[end - 1].order + secs[end].order) / 2 : secs[end - 1].order + 1) }), user));
    return out;
  }

  // The whole description as the editor shows it: each section's heading line and body.
  function specToText(project) {
    var ctx = specContext(project);
    return liveSpec(project).map(function (s) { return specHeadingLine(s) + (s.body ? '\n' + specToEditor(s.body, ctx) : ''); }).join('\n\n') + '\n';
  }
  // Saving the whole description: the records to write. Each heading in the text keeps the id of the
  // section it was, so links to it survive: headings matched in order by title, then a moved
  // heading by its title, then a renamed one by its place between matched ones. Sections whose
  // heading is gone are deleted; new headings become new sections. Only records that change are
  // returned (stamped).
  function specSaveAll(project, text, user) {
    var old = liveSpec(project), chunks = specSplit(text);
    var key = function (t) { return String(t || '').trim().toLowerCase(); };
    var heads = chunks.map(function (c) { return c.heading || { level: 1, title: 'Untitled', kind: '' }; });
    var match = heads.map(function () { return -1; }), used = old.map(function () { return false; });
    // 1. In order, by title (longest common subsequence).
    var n = heads.length, m = old.length, L = [];
    for (var i = 0; i <= n; i++) { L.push([]); for (var j = 0; j <= m; j++) L[i].push(0); }
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) {
      L[i][j] = key(heads[i].title) === key(old[j].title) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    for (i = 0, j = 0; i < n && j < m;) {
      if (key(heads[i].title) === key(old[j].title) && L[i][j] === L[i + 1][j + 1] + 1) { match[i] = j; used[j] = true; i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
    }
    // 2. A moved heading, by its title.
    heads.forEach(function (h, i) {
      if (match[i] >= 0) return;
      for (var j = 0; j < m; j++) if (!used[j] && key(old[j].title) === key(h.title)) { match[i] = j; used[j] = true; return; }
    });
    // 3. A renamed heading: unmatched headings between two matched ones pair with the unmatched
    //    sections between their matches, when the counts agree.
    for (i = 0; i < n;) {
      if (match[i] >= 0) { i++; continue; }
      var a = i; while (i < n && match[i] < 0) i++;
      var lo = a > 0 ? match[a - 1] : -1, hi = i < n ? match[i] : m;
      if (hi <= lo) continue;
      var free = []; for (j = lo + 1; j < hi; j++) if (!used[j]) free.push(j);
      if (free.length === i - a) free.forEach(function (jj, k) { match[a + k] = jj; used[jj] = true; });
    }
    // A renamed heading is renamed in the text's Uses lines too.
    heads.forEach(function (h, i) {
      if (match[i] < 0 || old[match[i]].title === h.title) return;
      chunks.forEach(function (c) { c.body = specRenameUses(c.body, old[match[i]].title, h.title); });
    });
    var view = Object.assign({}, project, { spec: Object.assign({}, project.spec || {}) });
    var recs = chunks.map(function (c, i) {
      var h = heads[i], fields = { order: i + 1, level: h.level, title: h.title, kind: h.kind, body: c.body };
      var r = match[i] >= 0 ? Object.assign({}, (project.spec || {})[old[match[i]].id], fields) : Object.assign(newSection({}, user), fields);
      view.spec[r.id] = r;
      return r;
    });
    var ctx = specContext(view), out = [];
    recs.forEach(function (r, i) {
      r.body = specFromEditor(r.body, ctx);
      if (match[i] >= 0) {
        var was = cleanSection((project.spec || {})[r.id]);
        if (was.order === r.order && was.level === r.level && was.title === r.title && was.kind === r.kind && was.body === r.body) return;
      }
      out.push(specStamp(r, user));
    });
    old.forEach(function (s, j) { if (!used[j]) out.push(specStamp(Object.assign({}, (project.spec || {})[s.id], { deleted: true }), user)); });
    return out;
  }

  // A starting description from the tool's template (config.spec.template), shaped by the review's
  // profile. The template is a list of entries { when: [tags], unless: [tags], lines: [...] }: an
  // entry is used when it has no `when` or the profile has one of them, and the profile has none of
  // its `unless`. "{name}" in a line is the review's name. Afterwards a Uses line keeps only the
  // sections that made it in (dropped when none did), and a heading left with no text and no
  // sections under it (a "## Drivers" with every driver left out) is dropped. Returns the text for
  // specSave, or '' when there's no template. The template is the tool's own; its text is trusted.
  function specTemplate(project, tpl) {
    tpl = tpl || (C.spec && C.spec.template);
    if (!Array.isArray(tpl) || !tpl.length) return '';
    var prof = (project && project.meta && project.meta.profile) || [];
    var has = function (t) { return prof.indexOf(t) >= 0; };
    var name = String((project && project.meta && project.meta.name) || '').trim() || 'Untitled';
    var lines = [];
    tpl.forEach(function (e) {
      if (!e || !Array.isArray(e.lines)) return;
      if (Array.isArray(e.when) && e.when.length && !e.when.some(has)) return;
      if (Array.isArray(e.unless) && e.unless.some(has)) return;
      if (lines.length && lines[lines.length - 1].trim()) lines.push('');
      e.lines.forEach(function (l) { lines.push(String(l).replace(/\{name\}/g, name)); });
    });
    var chunks = specSplit(lines.join('\n')).filter(function (c) { return c.heading; });
    for (var i = chunks.length - 1; i >= 0; i--) {
      var next = chunks[i + 1];
      if (!chunks[i].body.trim() && (!next || next.heading.level <= chunks[i].heading.level)) chunks.splice(i, 1);
    }
    var titles = {};
    chunks.forEach(function (c) { titles[c.heading.title.trim().toLowerCase()] = true; });
    return chunks.map(function (c) {
      var names = specUsesNames(c.body), body = c.body;
      if (names.length) body = specSetLine(body, 'uses', specLinkText(names.filter(function (n) { return titles[n.toLowerCase()]; }).map(function (n) { return { name: n, label: '' }; })));
      return specHeadingLine(c.heading) + (body ? '\n' + body : '');
    }).join('\n\n') + '\n';
  }

  // summary.spec: the top-level sections' gists (and the level under them when there's only one
  // top section; `depth` 0 or 1), the gaps, and the review notes, for Signoff PL. A heading with nothing
  // written under it but headings (a group like "## Interfaces") lists them as its gist; one with nothing
  // at all is left out, except the single top section.
  // At most SPEC_GISTS; `more` counts the ones past that (left out when none). Left out while the
  // description is empty, so other reviews keep their bytes.
  var SPEC_GISTS = 40;
  function specSummary(project) {
    if (!liveSpec(project).length || !specEnabled(project)) return null;
    var a = specAnalysis(project), top = Math.min.apply(null, a.sections.map(function (x) { return x.sec.level; }));
    var single = a.sections.filter(function (x) { return x.sec.level === top; }).length === 1;
    var cut = function (t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    // A group heading with no text of its own reads as the sections under it ("Status frame, Debug port").
    var gistOf = function (x) {
      if (x.gist) return x.gist;
      var kids = [];
      for (var j = x.index + 1; j < a.sections.length && a.sections[j].sec.level > x.sec.level; j++) if (a.sections[j].sec.level === x.sec.level + 1) kids.push(a.sections[j].sec.title || 'Untitled');
      return kids.join(', ');
    };
    var all = a.sections.filter(function (x) { return (x.sec.level === top && (single || gistOf(x))) || (single && x.sec.level === top + 1 && gistOf(x)); });
    var out = {
      gists: all.slice(0, SPEC_GISTS).map(function (x) {
        return { title: cut(x.sec.title, 120), gist: cut(gistOf(x), 300), depth: x.sec.level - top };
      }),
      sections: a.totals.sections, untraced: a.totals.untraced, undescribed: a.undescribed.length, flagged: a.tags.length, notes: a.totals.note
    };
    if (all.length > SPEC_GISTS) out.more = all.length - SPEC_GISTS;
    return out;
  }

  // Item states whose ID is in no current template and isn't a custom item:
  // the template retired them. Their state and comments are kept and shown.
  function retiredItems(project, index) {
    var ids = {};
    Object.keys(project.items).forEach(function (id) { ids[id] = 1; });
    liveComments(project).forEach(function (c) { if (c.item) ids[c.item] = 1; });
    return Object.keys(ids).filter(function (id) { return !index.items[id] && !project.custom[id]; });
  }

  // ── Merging ──────────────────────────────────────────────
  // Every record carries updatedAt / updatedBy; the newer one wins, key by key.
  // Deletions are tombstones (deleted: true), so merging never resurrects them.

  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    var ta = a.updatedAt || '', tb = b.updatedAt || '';
    if (ta !== tb) return ta > tb ? a : b;
    return (a.updatedBy || '') >= (b.updatedBy || '') ? a : b;
  }

  function mergeMaps(a, b) {
    var out = {};
    Object.keys(a || {}).forEach(function (k) { out[k] = a[k]; });
    Object.keys(b || {}).forEach(function (k) { out[k] = newer(out[k], b[k]); });
    return out;
  }

  // opts: { since, base } for the Scribe sections, see mergeSpec.
  function mergeProjects(local, remote, opts) {
    if (!local) return remote;
    if (!remote) return local;
    var versions = {};
    [remote.templateVersions || {}, local.templateVersions || {}].forEach(function (v) {
      Object.keys(v).forEach(function (k) { versions[k] = Math.max(versions[k] || 0, v[k]); });
    });
    return {
      schema: Math.max(local.schema || 1, remote.schema || 1),
      id: remote.id || local.id,
      slug: remote.slug || local.slug,
      createdAt: remote.createdAt < local.createdAt ? remote.createdAt : local.createdAt,
      createdBy: remote.createdBy || local.createdBy,
      templateVersions: versions,
      meta: newer(local.meta, remote.meta),
      items: mergeMaps(local.items, remote.items),
      sections: mergeMaps(local.sections, remote.sections),
      comments: mergeMaps(local.comments, remote.comments),
      custom: mergeMaps(local.custom, remote.custom),
      reqs: mergeMaps(local.reqs || {}, remote.reqs || {}),
      // Only once either copy has one, so documents without revisions keep their bytes.
      revisions: local.revisions || remote.revisions ? mergeMaps(local.revisions || {}, remote.revisions || {}) : undefined,
      spec: local.spec || remote.spec ? mergeSpec(local.spec || {}, remote.spec || {}, opts) : undefined,
      // Derived (see projectSummary): carried along for writers that can't rebuild it.
      summary: local.summary && remote.summary && (local.summary.at || '') > (remote.summary.at || '') ? local.summary : remote.summary || local.summary
    };
  }

  // ── Requirements ─────────────────────────────────────────
  // A project's own requirements (not from a template), in project.reqs:
  //   { id, ref: 'REQ-001', text, kind: 'shall' | 'should', category, source,
  //     method: inspection | analysis | demonstration | test,
  //     status: draft | approved | changed | deprecated, verify: open | pass | fail, evidence,
  //     links: [check ids it traces to], createdAt, updatedAt, updatedBy, deleted,
  //     discipline: sys | ee | me | fw | other (missing: this tool's own),
  //     parent: { tool: 'pl', project, id, ref, text } when it flows down from a Signoff PL
  //             requirement. Written by PL; ref and text are a snapshot for people without PL. }
  // Comments on a requirement are ordinary comments with item = the requirement's id.
  // A deprecated requirement is kept for reference (lined out) but no longer counts: it's left
  // out of the totals, verification, and failing flags.
  var REQ_METHODS = ['inspection', 'analysis', 'demonstration', 'test'];
  var REQ_STATUS = ['draft', 'approved', 'changed', 'deprecated'];
  var REQ_VERIFY = ['open', 'pass', 'fail'];
  var REQ_DISCIPLINES = ['sys', 'ee', 'me', 'fw', 'other'];

  // The discipline a requirement belongs to; records from before the field have this tool's.
  function ownDiscipline() {
    var d = String(C.discipline || '').toLowerCase();
    return d === 'pl' ? 'sys' : REQ_DISCIPLINES.indexOf(d) >= 0 ? d : 'other';
  }
  function reqDiscipline(q) { return oneOf(REQ_DISCIPLINES, q && q.discipline, ownDiscipline()); }

  // The PL requirement this one flows down from, or null. Review files are untrusted, so only
  // the known fields come through, as strings.
  function reqParent(q) {
    var p = q && q.parent;
    if (!p || typeof p !== 'object' || p.tool !== 'pl' || typeof p.id !== 'string' || typeof p.project !== 'string') return null;
    var s = function (v) { return typeof v === 'string' ? v.slice(0, 2000) : ''; };
    return { tool: 'pl', project: p.project.slice(0, 80), id: p.id.slice(0, 80), ref: s(p.ref).slice(0, 40), text: s(p.text) };
  }

  function refNumber(ref) { var m = /(\d+)\s*$/.exec(ref || ''); return m ? parseInt(m[1], 10) : 0; }

  function liveReqs(project) {
    var r = project.reqs || {};
    return Object.keys(r).map(function (k) { return r[k]; }).filter(function (q) { return !q.deleted; })
      .sort(function (a, b) {
        var pa = (a.ref || '').replace(/\d+\s*$/, ''), pb = (b.ref || '').replace(/\d+\s*$/, '');
        return pa.localeCompare(pb) || refNumber(a.ref) - refNumber(b.ref) || (a.createdAt || '').localeCompare(b.createdAt || '');
      });
  }

  // Next free ID, following the project's most-used numbering (an imported GEN-001… list goes on
  // with GEN-124), else REQ-001. Two people adding offline can pick the same number; the page flags it.
  function nextReqRef(project) {
    var counts = {}, max = {}, width = {};
    liveReqs(project).forEach(function (q) {
      var m = /^(.*?)(\d+)\s*$/.exec(q.ref || ''); if (!m) return;
      var pre = m[1];
      counts[pre] = (counts[pre] || 0) + 1;
      max[pre] = Math.max(max[pre] || 0, parseInt(m[2], 10));
      width[pre] = Math.max(width[pre] || 0, m[2].length);
    });
    var pre = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
    return pre === undefined ? 'REQ-001' : pre + String(max[pre] + 1).padStart(width[pre], '0');
  }

  function newReq(project, fields, user) {
    var t = now();
    var q = Object.assign({ id: uid('q'), ref: nextReqRef(project), text: '', kind: 'shall', category: '', source: '',
      method: 'inspection', status: 'draft', verify: 'open', evidence: '', links: [], discipline: ownDiscipline(), createdAt: t }, fields || {});
    return stamp(q, user);
  }

  // Every check in the project's checklists, by id: { status, text, template, section, custom }.
  function checkIndex(project, templates) {
    var out = {};
    templates.forEach(function (t) {
      if (project.meta.checklists.indexOf(t.id) < 0) return;
      checklistRows(project, t).forEach(function (g) {
        g.rows.forEach(function (r) {
          out[r.id] = { id: r.id, status: r.status, text: r.def.text, template: t, section: g.section, custom: r.custom, resolution: r.resolution, reference: r.reference };
        });
      });
    });
    return out;
  }

  // How the checks a requirement traces to stand: counts by status, plus links to checks that
  // no longer exist (removed custom checks, or checklists taken off the project).
  function reqTrace(req, index) {
    var t = { linked: 0, pass: 0, issue: 0, open: 0, na: 0, missing: 0 };
    (req.links || []).forEach(function (id) {
      var c = index[id];
      if (!c) { t.missing++; return; }
      t.linked++;
      // A fixed issue still needs checking again; a waived one has been accepted.
      if (c.status === 'issue' && c.resolution === 'fixed') t.open++;
      else if (c.status === 'issue' && c.resolution === 'waived') t.pass++;
      else t[c.status]++;
    });
    t.state = !t.linked ? 'none' : t.issue ? 'issue' : t.open ? 'open' : 'pass';
    return t;
  }

  // Where a requirement stands, worst first:
  //   deprecated; fail (its verification failed); risk (an open issue on a check it traces to,
  //   even if it was verified); pass (verified); open.
  function reqState(q, index) {
    if (q.status === 'deprecated') return 'deprecated';
    if (q.verify === 'fail') return 'fail';
    if (reqTrace(q, index || {}).state === 'issue') return 'risk';
    return q.verify === 'pass' ? 'pass' : 'open';
  }

  // With the check index, `risk` counts the requirements at risk (see reqState).
  function reqStats(project, index) {
    var s = { total: 0, approved: 0, draft: 0, changed: 0, deprecated: 0, pass: 0, fail: 0, open: 0, risk: 0, unlinked: 0, duplicates: [] };
    var seen = {};
    liveReqs(project).forEach(function (q) {
      var k = (q.ref || '').toUpperCase();
      if (k && seen[k]) s.duplicates.push(q.ref);
      seen[k] = 1;
      if (q.status === 'deprecated') { s.deprecated++; return; }
      s.total++;
      s[q.status] = (s[q.status] || 0) + 1;
      s[q.verify] = (s[q.verify] || 0) + 1;
      if (!(q.links || []).length) s.unlinked++;
      if (index && reqState(q, index) === 'risk') s.risk++;
    });
    return s;
  }

  // CSV or tab-separated text (as pasted from Excel) -> array of rows.
  function parseTable(text) {
    text = String(text || '').replace(/^﻿/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var sep = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
    var rows = [], row = [], cell = '', quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
  }

  // Header names accepted when importing, by field.
  var REQ_COLUMNS = {
    ref: /^(id|ref|req(uirement)?\.?\s*(id|#|no\.?|number)|#)$/i,
    title: /^(name|title|short\s*name|summary)$/i,
    text: /^(requirement|text|description|statement|req(uirement)?\s*text)$/i,
    kind: /^(type|kind|shall\s*\/\s*should|level|priority)$/i,
    category: /^(category|area|group|sub-?\s*system)$/i,
    source: /^(source|spec|reference|doc(ument)?|origin|rationale)\b/i,
    method: /^(verification(\s*method)?|method|verify\s*by|v&v)$/i,
    status: /^(status|state)$/i,
    discipline: /^(discipline|class|classification|domain)$/i
  };

  // A spreadsheet's discipline words -> ours ('' keeps the requirement's own).
  function importDiscipline(raw) {
    if (!raw) return '';
    if (/^sys|system|product/.test(raw)) return 'sys';
    if (/^ee$|elec/.test(raw)) return 'ee';
    if (/^me$|mech/.test(raw)) return 'me';
    if (/^fw$|^sw$|firm|soft/.test(raw)) return 'fw';
    return 'other';
  }

  // A spreadsheet's status words -> ours ('' leaves the status as it is).
  function importStatus(raw) {
    if (/obsolete|deprecat|withdrawn|supersed|cancel|removed|deleted|retired/.test(raw)) return 'deprecated';
    if (/changed/.test(raw)) return 'changed';
    if (/approved|accepted|active|implemented|released|baselined/.test(raw)) return 'approved';
    return raw ? 'draft' : '';
  }

  // Rows (with a header row) -> requirement records for `project`. Rows whose ID matches an
  // existing requirement update it; the rest are added. Resolves { added, updated, skipped }.
  function importReqs(project, rows, user) {
    var res = { added: 0, updated: 0, skipped: 0, records: [] };
    if (rows.length < 2) return res;
    var head = rows[0].map(function (h) { return String(h).trim(); });
    var col = {};
    Object.keys(REQ_COLUMNS).forEach(function (f) {
      var i = head.findIndex(function (h) { return REQ_COLUMNS[f].test(h); });
      if (i >= 0) col[f] = i;
    });
    if (col.text === undefined) throw new Error('No "Requirement" (or "Text" / "Description") column in the first row');
    var byRef = {};
    liveReqs(project).forEach(function (q) { byRef[(q.ref || '').toUpperCase()] = q; });
    var scratch = { reqs: Object.assign({}, project.reqs || {}) };
    rows.slice(1).forEach(function (r) {
      var get = function (f) { return col[f] === undefined ? '' : String(r[col[f]] || '').trim(); };
      var text = get('text'), title = get('title');
      if (!text) { res.skipped++; return; }
      // A short name column ("Power input voltage") leads the statement, which often needs it.
      if (title && text.toLowerCase().indexOf(title.toLowerCase()) !== 0) text = title + ': ' + text;
      var kindRaw = get('kind').toLowerCase(), methodRaw = get('method').toLowerCase();
      var fields = {
        text: text,
        category: get('category'),
        source: get('source'),
        kind: /should|could|won'?t|may\b|desired|optional|goal|nice/.test(kindRaw) || (!kindRaw && /\bshould\b/i.test(text) && !/\bshall\b/i.test(text)) ? 'should' : 'shall',
        method: REQ_METHODS.filter(function (m) { return methodRaw.indexOf(m.slice(0, 4)) >= 0; })[0] || (methodRaw === 'i' ? 'inspection' : methodRaw === 'a' ? 'analysis' : methodRaw === 'd' ? 'demonstration' : methodRaw === 't' ? 'test' : 'inspection')
      };
      var status = importStatus(get('status').toLowerCase());
      if (status) fields.status = status;
      var discipline = importDiscipline(get('discipline').toLowerCase());
      if (discipline) fields.discipline = discipline;
      var ref = get('ref');
      var existing = ref && byRef[ref.toUpperCase()];
      var rec;
      if (existing) {
        rec = stamp(Object.assign({}, existing, fields, !status && existing.status === 'approved' && existing.text !== text ? { status: 'changed' } : {}), user);
        res.updated++;
      } else {
        rec = newReq(scratch, Object.assign(ref ? { ref: ref } : {}, fields), user);
        res.added++;
      }
      scratch.reqs[rec.id] = rec;
      if (rec.ref) byRef[rec.ref.toUpperCase()] = rec;
      res.records.push(rec);
    });
    return res;
  }

  function csvCell(v) { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  // Compliance matrix as CSV: one row per requirement, with what it traces to.
  function reqsCsv(project, index) {
    var rows = [['ID', 'Requirement', 'Type', 'Discipline', 'Category', 'Source', 'Parent', 'Verification method', 'Status', 'Verified', 'Evidence', 'Traced checks', 'Trace status', 'State']];
    liveReqs(project).forEach(function (q) {
      var t = reqTrace(q, index), parent = reqParent(q);
      rows.push([q.ref, q.text, q.kind, reqDiscipline(q), q.category, q.source, parent ? parent.ref + ' (Signoff PL)' : '', q.method, q.status, q.verify, q.evidence,
        (q.links || []).map(function (id) {
          var c = index[id];
          return c ? c.text + ' [' + c.status + (c.resolution ? ', ' + c.resolution : '') + ']' : id + ' [no longer in the project]';
        }).join(' | '),
        t.state === 'none' ? 'not traced' : t.pass + ' pass, ' + t.issue + ' issue, ' + t.open + ' to review' + (t.na ? ', ' + t.na + ' N/A' : ''),
        { fail: 'failing', risk: 'at risk', pass: 'verified', open: 'open', deprecated: 'deprecated' }[reqState(q, index)]]);
    });
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  // Working copies (slug -> doc) written by another tab, or by Fabcheck's "Send to Signoff",
  // merged into ours. Projects match by id, not slug; a new one keeps its slug unless that
  // slug is taken here. changed is false when theirs adds nothing, so callers don't write back.
  // opts.since(id): mergeProjects' since for our copy of that project (see mergeSpec).
  function mergeLocalCopies(ours, theirs, opts) {
    var sinceFor = opts && opts.since || function () { return ''; };
    var out = {}, bySlug = {}, changed = false;
    Object.keys(ours || {}).forEach(function (slug) { out[slug] = ours[slug]; bySlug[ours[slug].id] = slug; });
    Object.keys(theirs || {}).forEach(function (slug) {
      var doc = theirs[slug];
      if (!doc || !doc.id || !doc.meta) return;
      var mine = bySlug[doc.id];
      if (mine) {
        var merged = mergeProjects(out[mine], doc, { since: sinceFor(doc.id) });
        if (stableStringify(merged) !== stableStringify(out[mine])) { out[mine] = merged; changed = true; }
        return;
      }
      var free = slug, n = 2;
      while (out[free]) free = slug + '-' + n++;
      out[free] = doc; bySlug[doc.id] = free; changed = true;
    });
    return { projects: out, changed: changed };
  }

  // ── Revisions (docs/fabcheck-link.md, "Revisions") ────────
  // Tags on runs a checker stored with the review (Fabcheck's, for Signoff EE), in
  // project.revisions, merged like every other record:
  //   { id, label: '3.2', title, status: 'sent' | 'built' | 'withdrawn',
  //     source: { tool: 'fabcheck', run, at, package: { key, sha256, name }, zip: { path, sha256, size } | null },
  //     fab: { house, sentAt: 'YYYY-MM-DD', ref }, notes, createdAt, updatedAt, updatedBy, deleted }
  // A review round (later) adds `round` beside these fields.
  var REV_STATUS = ['sent', 'built', 'withdrawn'];
  var REV_STATUS_LABEL = { sent: 'Sent to fab', built: 'Used for builds', withdrawn: 'Withdrawn' };
  var RUN_ID = /^[A-Za-z0-9_-]{1,64}$/, HEX16 = /^[0-9a-f]{16}$/, HEX64 = /^[0-9a-f]{64}$/;
  function clip(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }
  function isoDay(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }
  function isoTime(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) ? v : ''; }
  function hex(v, re) { v = typeof v === 'string' ? v.toLowerCase() : ''; return re.test(v) ? v : ''; }

  // A stored revision record as it's safe to use: known enums, text cut to size.
  function cleanRevision(r, key) {
    var src = r.source && typeof r.source === 'object' ? r.source : {};
    var pkg = src.package && typeof src.package === 'object' ? src.package : {};
    var zip = src.zip && typeof src.zip === 'object' ? src.zip : null;
    var fab = r.fab && typeof r.fab === 'object' ? r.fab : {};
    return {
      id: key, label: clip(r.label, 40), title: clip(r.title, 200), status: oneOf(REV_STATUS, r.status, 'sent'),
      source: { tool: oneOf(['fabcheck'], src.tool, ''), run: RUN_ID.test(src.run || '') ? src.run : '', at: isoTime(src.at),
        package: { key: hex(pkg.key, HEX16), sha256: hex(pkg.sha256, HEX64), name: clip(pkg.name, 200) },
        zip: zip ? { path: clip(zip.path, 400), sha256: hex(zip.sha256, HEX64), size: +zip.size || 0 } : null },
      fab: { house: clip(fab.house, 100), sentAt: isoDay(fab.sentAt), ref: clip(fab.ref, 100) },
      notes: clip(r.notes, 4000), createdAt: isoTime(r.createdAt), updatedAt: isoTime(r.updatedAt), updatedBy: clip(r.updatedBy, 100)
    };
  }

  // Live revisions, oldest first: by the run they tag, then when they were tagged. "Superseded"
  // and "latest" follow this order.
  function liveRevisions(project) {
    var r = project.revisions || {};
    // The id is the record's key, so an edit always lands on the record it came from.
    return Object.keys(r).filter(function (k) { var x = r[k]; return x && typeof x === 'object' && !x.deleted; })
      .map(function (k) { return cleanRevision(r[k], k); })
      .sort(function (a, b) {
        return (a.source.at || a.createdAt).localeCompare(b.source.at || b.createdAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      });
  }

  // The latest revision that wasn't withdrawn (else the latest), or null.
  function latestRevision(project) {
    var all = liveRevisions(project), live = all.filter(function (r) { return r.status !== 'withdrawn'; });
    return live[live.length - 1] || all[all.length - 1] || null;
  }

  // The revision that came after this one, skipping withdrawn ones; null for the latest.
  function supersededBy(project, id) {
    var all = liveRevisions(project), i = all.map(function (r) { return r.id; }).indexOf(id);
    if (i < 0 || all[i].status === 'withdrawn') return null;
    for (var j = i + 1; j < all.length; j++) if (all[j].status !== 'withdrawn') return all[j];
    return null;
  }

  // The revision a run is tagged as (the latest, if it's tagged twice), or null.
  function revisionForRun(project, runId) {
    var hits = runId ? liveRevisions(project).filter(function (r) { return r.source.run === runId; }) : [];
    return hits[hits.length - 1] || null;
  }

  // The suggested next label: the last number of the latest label, plus one (3.1 → 3.2, 3.9 →
  // 3.10). With none yet, the review's revision with .1, or 1.
  function nextRevLabel(project) {
    var all = liveRevisions(project), last = all[all.length - 1];
    if (last && /\d+(?!.*\d)/.test(last.label)) return last.label.replace(/(\d+)(?!.*\d)/, function (n) { return String(parseInt(n, 10) + 1); });
    var rev = String((project.meta && project.meta.revision) || '').trim();
    return rev ? rev + '.1' : '1';
  }

  // A new revision tagging `run` (cleanRun's shape). fields: { label, title, status, house, sentAt, ref, notes }.
  function newRevision(run, fields, user) {
    var t = now();
    return stamp({
      id: uid('v'), label: clip(fields.label, 40), title: clip(fields.title, 200), status: oneOf(REV_STATUS, fields.status, 'sent'),
      source: { tool: 'fabcheck', run: run.id, at: run.at, package: { key: run.package.key, sha256: run.package.sha256, name: run.package.name },
        zip: run.zip ? { path: run.zip.path, sha256: run.zip.sha256, size: run.zip.size } : null },
      fab: { house: clip(fields.house, 100), sentAt: isoDay(fields.sentAt), ref: clip(fields.ref, 100) },
      notes: clip(fields.notes, 4000), createdAt: t, deleted: false
    }, user);
  }

  // A run file Fabcheck stored ({ run, findings }, docs/fabcheck-link.md) as Signoff uses it, or
  // null if it isn't one. Anyone who can write the review's repo wrote it, so ids, hashes and
  // paths are checked and text is cut to size. The zip's place is kept relative to the run's
  // folder (`packages/<key>/<name>.zip`): its stored path can name the data repo's folder from
  // before the review was shared. `raw` is the record as stored, for handing on to Fabcheck.
  function cleanRun(file) {
    var run = file && file.run;
    if (!run || typeof run !== 'object' || !RUN_ID.test(run.id || '')) return null;
    var pkg = run.package && typeof run.package === 'object' ? run.package : {};
    var z = pkg.zip && typeof pkg.zip === 'object' ? pkg.zip : null, zip = null;
    var m = z && typeof z.path === 'string' && z.path.indexOf('..') < 0 && /(?:^|\/)packages\/([0-9a-f]{16})\/([\w.+-][\w.+ -]{0,150}\.zip)$/.exec(z.path);
    if (m && HEX64.test(String(z.sha256 || '').toLowerCase())) {
      zip = { rel: 'packages/' + m[1] + '/' + m[2], path: z.path, name: m[2], sha256: z.sha256.toLowerCase(), size: +z.size || 0, root: clip(z.root, 200),
        files: (Array.isArray(z.files) ? z.files : []).filter(function (f) { return f && typeof f === 'object'; }).slice(0, 2000).map(function (f) {
          return { path: clip(f.path, 400), to: clip(f.to, 400), size: +f.size || 0, sha256: hex(f.sha256, HEX64) };
        }) };
    }
    var sum = run.summary && typeof run.summary === 'object' ? run.summary : {}, set = run.settings && typeof run.settings === 'object' ? run.settings : {};
    return {
      id: run.id, at: isoTime(run.at), by: clip(run.by, 100),
      package: { key: hex(pkg.key, HEX16), sha256: hex(pkg.sha256, HEX64), name: clip(pkg.name, 200), size: +pkg.size || 0 },
      summary: { error: +sum.error || 0, warn: +sum.warn || 0, info: +sum.info || 0 },
      profile: clip(set.profileName || set.profile, 100), zip: zip,
      raw: run, findings: Array.isArray(file.findings) ? file.findings : []
    };
  }

  // Runs as the Revisions tab lists them: one group per package (by key), newest first, each with
  // its runs newest first.
  function groupRuns(runs) {
    var by = {}, order = [];
    runs.forEach(function (r) {
      var k = r.package.key || r.package.sha256 || r.id;
      if (!by[k]) { by[k] = { key: k, runs: [] }; order.push(k); }
      by[k].runs.push(r);
    });
    var newest = function (a, b) { return b.at.localeCompare(a.at) || b.id.localeCompare(a.id); };
    return order.map(function (k) { by[k].runs.sort(newest); return by[k]; })
      .sort(function (a, b) { return newest(a.runs[0], b.runs[0]); });
  }

  // A run's zip contents grouped by folder, as in the zip: [{ folder: 'Fabrication/Gerber', files:
  // [{ name, path, size }] }], Fabrication's folders first, then Assembly's, then the rest, then
  // files at the top.
  function zipFolders(zip) {
    var by = {}, root = zip && zip.root ? zip.root + '/' : '';
    ((zip && zip.files) || []).forEach(function (f) {
      var inZip = f.to && f.to.indexOf(root) === 0 ? f.to.slice(root.length) : (f.to || f.path);
      var cut = inZip.lastIndexOf('/'), folder = cut > 0 ? inZip.slice(0, cut) : '';
      (by[folder] = by[folder] || []).push({ name: cut > 0 ? inZip.slice(cut + 1) : inZip, path: f.path, size: f.size });
    });
    var rank = function (f) { var top = f.split('/')[0]; return top === 'Fabrication' ? 0 : top === 'Assembly' ? 1 : f ? 2 : 3; };
    return Object.keys(by).sort(function (a, b) { return rank(a) - rank(b) || a.localeCompare(b); }).map(function (f) {
      return { folder: f, files: by[f].sort(function (a, b) { return a.name.localeCompare(b.name); }) };
    });
  }

  // ── People ───────────────────────────────────────────────
  // users.json in the FTE-only data repo:
  //   users:  { login: { login, name, role: 'fte' | 'client' | 'contractor', projects: [ids] } }
  //   A client and a contractor get the same access (only the projects shared with them); the role
  //   only says who they are. Anything that isn't an FTE counts as outside (isOutside).
  //   shared: { projectId: { id, repo: 'owner/name', name } }  projects that live in their
  //           own private repository, so contractors can be given access to just that one.
  // GitHub collaborator lists decide who can actually open what; `projects` on a contractor
  // records who should be on which project, so the People page can flag differences.

  function emptyRoster() { return { schema: 1, users: {}, shared: {} }; }

  function mergeRosters(a, b) {
    return {
      schema: 1,
      users: mergeMaps((a && a.users) || {}, (b && b.users) || {}),
      shared: mergeMaps((a && a.shared) || {}, (b && b.shared) || {})
    };
  }

  function liveUsers(roster) {
    var users = (roster && roster.users) || {};
    return Object.keys(users).map(function (k) { return users[k]; }).filter(function (u) { return !u.deleted; })
      .sort(function (x, y) { return (roleRank(x) - roleRank(y)) || (x.name || x.login).localeCompare(y.name || y.login); });
  }

  // The repository a shared project lives in ('owner/name'), or '' if it's internal.
  function sharedRepo(roster, projectId) {
    var s = roster && roster.shared && roster.shared[projectId];
    return s && !s.deleted ? s.repo : '';
  }

  // FTEs first, then clients, then contractors (and any role a newer tool wrote).
  var ROLE_RANK = { fte: 0, client: 1, contractor: 2 };
  function roleRank(u) { return u && ROLE_RANK.hasOwnProperty(u.role) ? ROLE_RANK[u.role] : 3; }
  // Someone outside the team: a client or a contractor, who opens only what's shared with them.
  function isOutside(u) { return !!u && !u.deleted && u.role !== 'fte'; }

  // Role from the People list, for display. The repo owner is always an FTE, and so is
  // everyone while the list is empty (so the first person setting it up isn't locked out).
  function roleOf(login, roster, owner) {
    if (!login) return 'fte';
    login = login.toLowerCase();
    if (owner && owner.toLowerCase() === login) return 'fte';
    var people = liveUsers(roster);
    if (!people.length) return 'fte';
    var u = people.filter(function (x) { return x.login === login; })[0];
    return u ? u.role : 'none';
  }

  // JSON with sorted keys, so the same document always serializes the same way
  // and git diffs only show real changes.
  function stableStringify(value) {
    return JSON.stringify(sortKeys(value), null, 2) + '\n';
  }
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).sort().forEach(function (k) { if (v[k] !== undefined) out[k] = sortKeys(v[k]); });
      return out;
    }
    return v;
  }

  // ── Legacy import (design_review_checklists.html exports, version 3.0) ──
  // That tool stored checks[tab][itemId] = true | 'na' | false, sectionNA[tab][sectionId],
  // and the full (possibly edited) categories. Items it had that aren't in the current
  // templates come across as custom items.
  var LEGACY_TABS = C.legacyTabs || [];

  function importLegacy(data, user, templates) {
    var index = indexTemplates(templates);
    var p = newProject({
      name: data.projectName || 'Imported review',
      stage: C.defaultStage,
      checklists: LEGACY_TABS.filter(function (id) { return templates.some(function (t) { return t.id === id; }); })
    }, user, templates);
    var t = now();
    (data.categories || []).forEach(function (cats, tab) {
      var checklist = LEGACY_TABS[tab];
      var tpl = templates.filter(function (x) { return x.id === checklist; })[0];
      if (!tpl) return;
      (cats || []).forEach(function (cat) {
        // A section the user added in the old tool lands in the checklist's first section.
        var sec = index.sections[cat.id] ? cat.id : tpl.sections[0].id;
        (cat.items || []).forEach(function (it) {
          if (index.items[it.id]) return;
          p.custom[it.id] = { id: it.id, checklist: checklist, section: sec, text: it.text, hint: it.note || '',
            severity: 'minor', createdAt: t, updatedAt: t, updatedBy: user || '' };
        });
      });
    });
    (data.checks || []).forEach(function (checks) {
      Object.keys(checks || {}).forEach(function (id) {
        var v = checks[id];
        if (v === true) p.items[id] = { status: 'pass', updatedAt: t, updatedBy: user || '' };
        else if (v === 'na') p.items[id] = { status: 'na', updatedAt: t, updatedBy: user || '' };
      });
    });
    (data.sectionNA || []).forEach(function (sec) {
      Object.keys(sec || {}).forEach(function (id) {
        if (sec[id]) p.sections[id] = { na: true, updatedAt: t, updatedBy: user || '' };
      });
    });
    return p;
  }

  function isLegacy(data) {
    return LEGACY_TABS.length > 0 && !!data && Array.isArray(data.checks) && !data.meta;
  }

  S.model = {
    STATUSES: STATUSES, SEVERITIES: SEVERITIES, RESOLUTIONS: RESOLUTIONS, TAGS: TAGS, STAGES: STAGES,
    now: now, oneOf: oneOf, uid: uid, slugify: slugify, stamp: stamp, tokenTag: tokenTag,
    resolveTemplates: resolveTemplates, indexTemplates: indexTemplates, applies: applies,
    newProject: newProject, checklistRows: checklistRows, countStatuses: countStatuses,
    projectStats: projectStats, reqsEnabled: reqsEnabled, projectSummary: projectSummary, withSummary: withSummary, projectGroups: projectGroups,
    isAssembly: isAssembly, cleanPlPart: cleanPlPart, plSlim: plSlim, plWaiting: plWaiting,
    liveComments: liveComments, retiredItems: retiredItems, changesSince: changesSince,
    isRevNote: isRevNote, stripRevNote: stripRevNote, revNotes: revNotes,
    specKinds: specKinds, specKindInfo: specKindInfo, specLinkWords: specLinkWords, specLinkWord: specLinkWord, specKindLink: specKindLink, specLinkItems: specLinkItems, specLinkText: specLinkText, specUsesItems: specUsesItems, specEnabled: specEnabled, liveSpec: liveSpec, newSection: newSection, specStamp: specStamp, mergeSpec: mergeSpec, specBase: specBase, specStampKey: specStampKey, specHeading: specHeading, specHeadingLine: specHeadingLine, specPlain: specPlain,
    specSpans: specSpans, specCells: specCells, specUseIs: specUseIs, specUseId: specUseId, specRemoveUnit: specRemoveUnit, specBrokenMarks: specBrokenMarks, SPEC_BODY_MAX: SPEC_BODY_MAX, specTooLong: specTooLong, specKindLabel: specKindLabel, specKindPlural: specKindPlural, specSentences: specSentences, specContext: specContext, specBlocks: specBlocks, specAnalysis: specAnalysis, specEdit: specEdit,
    specToEditor: specToEditor, specFromEditor: specFromEditor, specSplit: specSplit, specSave: specSave, specToText: specToText, specSaveAll: specSaveAll, specSetLine: specSetLine, specUsesNames: specUsesNames, specRenameUses: specRenameUses, specRename: specRename, specAddBlock: specAddBlock, specMoveBlock: specMoveBlock, specNest: specNest, specGroup: specGroup, specUngroup: specUngroup, specCommentTags: specCommentTags, specMarkdown: specMarkdown, specSummary: specSummary, specTemplate: specTemplate,
    newer: newer, mergeMaps: mergeMaps, mergeProjects: mergeProjects, mergeLocalCopies: mergeLocalCopies,
    stableStringify: stableStringify, importLegacy: importLegacy, isLegacy: isLegacy,
    emptyRoster: emptyRoster, mergeRosters: mergeRosters, liveUsers: liveUsers, isOutside: isOutside, roleOf: roleOf, sharedRepo: sharedRepo,
    REQ_METHODS: REQ_METHODS, REQ_STATUS: REQ_STATUS, REQ_VERIFY: REQ_VERIFY, REQ_DISCIPLINES: REQ_DISCIPLINES,
    liveReqs: liveReqs, nextReqRef: nextReqRef, newReq: newReq, checkIndex: checkIndex, reqTrace: reqTrace, reqStats: reqStats,
    reqState: reqState, reqDiscipline: reqDiscipline, ownDiscipline: ownDiscipline, reqParent: reqParent, reqSummaryList: reqSummaryList,
    parseTable: parseTable, importReqs: importReqs, reqsCsv: reqsCsv,
    REV_STATUS: REV_STATUS, REV_STATUS_LABEL: REV_STATUS_LABEL, liveRevisions: liveRevisions, latestRevision: latestRevision,
    supersededBy: supersededBy, revisionForRun: revisionForRun, nextRevLabel: nextRevLabel, newRevision: newRevision,
    cleanRevision: cleanRevision, cleanRun: cleanRun, groupRuns: groupRuns, zipFolders: zipFolders
  };
})(window.Signoff = window.Signoff || {});
