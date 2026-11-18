/* The route an update takes, drawn above the flash steps: this computer → the board (a direct load
   over DfuSe), or this computer → the host board → the board (a bridge board, through the host's
   passthrough). Each stop names what it's doing right now, the live link moves, and a block map under
   it shows the image, block by block. Designed in lab/passthrough.html (concept C, Chris 2026-11-17).

   FL.route.html({ nodes: [{ icon, name, status, on, live }], links: [bool], note, cells: [state], legend })
     icon: 'pc' | 'board' | 'host' | 'target' | 'probe' | 'chip'.  cells: 'unk' (not reached yet), 'same' (checked, left
     alone), 'diff' (differs or written, not yet checked), 'now', 'done' (written and read back),
     'erased'. legend: [[state, words]]. Severities never by hue alone: states differ by fill pattern. */
(function (FL) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var IC = {
    pc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12" rx="1.8"/><path d="M1.5 19.5h21"/></svg>',
    board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M1 10.5h2M1 13.5h2"/></svg>',
    host: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M1 10.5h2M1 13.5h2M21 12h2"/></svg>',
    probe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="13" rx="2"/><path d="M10 15.5v3M14 15.5v3M9 21.5h6M10 6.5h4"/></svg>',
    chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/></svg>',
    target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="6" y="8" width="12" height="6" rx="1"/><path d="M1 12h2"/></svg>'
  };

  function html(m) {
    var h = '<div class="fl-route"><div class="fl-route-row"><span class="fl-chain">';
    m.nodes.forEach(function (n, i) {
      if (i) h += '<span class="via' + (m.links[i - 1] ? ' on' : '') + '"></span>';
      h += '<span class="hop' + (n.on ? ' on' : '') + '"><span class="hop-name">' + (IC[n.icon] || IC.board) + esc(n.name) + '</span>' +
        '<span class="hop-status' + (n.live ? ' live' : '') + (n.good ? ' good' : '') + '">' + esc(n.status) + '</span></span>';
    });
    h += '</span>' + (m.note ? '<span class="fl-route-note">' + esc(m.note) + '</span>' : '') + '</div>';
    if (m.cells && m.cells.length) {
      h += '<div class="fl-blocks" role="img" aria-label="' + esc(m.cellsLabel || 'The image, block by block') + '">' +
        m.cells.map(function (s) { return '<i class="fl-blk ' + s + '"></i>'; }).join('') + '</div>';
      if (m.legend) h += '<div class="fl-legend"><b class="fl-legend-label">' + esc(m.legendLabel || 'Flash block status:') + '</b>' + m.legend.map(function (l) { return '<span><i class="fl-blk ' + l[0] + '"></i>' + esc(l[1]) + '</span>'; }).join('') + '</div>';
    }
    return h + '</div>';
  }

  /* n cells for a fraction of the work done in each of three passes (erase, write, verify). */
  function passes(n, erase, write, verify) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var at = (i + 1) / n;
      out.push(verify >= at ? 'done' : write >= at ? 'diff' : erase >= at ? 'erased' : 'unk');
    }
    // The cell being worked on blinks.
    var cur = verify > 0 && verify < 1 ? Math.floor(verify * n) : write > 0 && write < 1 ? Math.floor(write * n) : erase > 0 && erase < 1 ? Math.floor(erase * n) : -1;
    if (cur >= 0 && cur < n) out[cur] = 'now';
    return out;
  }

  FL.route = { html: html, passes: passes };
})(window.FL = window.FL || {});
