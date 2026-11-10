/* A small terminal for the board's console: enough of a VT100 to draw what a firmware console with
   its own line editing sends (such a console sends \r, \n, \b, ESC[K, ESC[nC/D, ESC[2J, ESC[H, and
   redraws its line for history and Tab completion), and the keys such a console expects.

   FL.term.Screen is the text and the cursor, with no DOM, so tests can feed it bytes. Every key goes
   to the board as the bytes a terminal sends (FL.term.keyBytes); the board echoes and edits. */
(function (FL) {
  'use strict';

  var ROWS = 24;   // the screen a cursor-position or clear refers to: the last ROWS lines

  function Screen(opts) {
    opts = opts || {};
    this.max = opts.max || 2000;
    this.clear();
  }

  Screen.prototype.clear = function () {
    this.lines = [[]]; this.row = 0; this.col = 0;
    this.state = 0; this.params = ''; this.version = (this.version || 0) + 1;
  };

  Screen.prototype.top = function () { return Math.max(0, this.lines.length - ROWS); };

  Screen.prototype.ensure = function (row) { while (this.lines.length <= row) this.lines.push([]); };

  Screen.prototype.newline = function () {
    this.row++;
    this.ensure(this.row);
    var extra = this.lines.length - this.max;
    if (extra > 0) { this.lines.splice(0, extra); this.row -= extra; }
  };

  Screen.prototype.put = function (ch) {
    var line = this.lines[this.row];
    while (line.length < this.col) line.push(' ');
    line[this.col] = ch;
    this.col++;
  };

  Screen.prototype.csi = function (f, p) {
    var priv = p.charAt(0) === '?';
    var nums = (priv ? p.slice(1) : p).split(';').map(function (n) { return parseInt(n, 10); });
    var n = nums[0] > 0 ? nums[0] : 1, line = this.lines[this.row];
    if (priv) return;   // modes (cursor show/hide and the like): nothing to draw
    switch (f) {
      case 'A': this.row = Math.max(this.top(), this.row - n); break;
      case 'B': this.row += n; this.ensure(this.row); break;
      case 'C': this.col += n; break;
      case 'D': this.col = Math.max(0, this.col - n); break;
      case 'G': this.col = n - 1; break;
      case 'H': case 'f': {
        var r = nums[0] > 0 ? nums[0] : 1, c = nums[1] > 0 ? nums[1] : 1;
        this.row = this.top() + r - 1; this.col = c - 1; this.ensure(this.row);
        break;
      }
      case 'J': {
        var mode = nums[0] || 0;
        if (mode === 2 || mode === 3) { this.lines = [[]]; this.row = 0; this.col = 0; }
        else if (mode === 0) { line.length = Math.min(line.length, this.col); this.lines.length = this.row + 1; }
        break;
      }
      case 'K': {
        var k = nums[0] || 0;
        if (k === 0) line.length = Math.min(line.length, this.col);
        else if (k === 1) { for (var i = 0; i <= this.col && i < line.length; i++) line[i] = ' '; }
        else if (k === 2) this.lines[this.row] = [];
        break;
      }
      default: break;   // colors (m) and anything else: ignored
    }
  };

  // Feed text from the board.
  Screen.prototype.write = function (text) {
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i), code = text.charCodeAt(i);
      switch (this.state) {
        case 1:   // after ESC
          if (ch === '[') { this.state = 2; this.params = ''; }
          else if (ch === ']') this.state = 3;
          else if (ch === '(' || ch === ')') this.state = 4;
          else if (ch === 'c') this.clear();
          else this.state = 0;
          if (this.state === 1) this.state = 0;
          continue;
        case 2:   // CSI parameters, then a final byte
          if (/[0-9;?]/.test(ch)) this.params += ch;
          else if (code >= 0x40 && code <= 0x7e) { this.state = 0; this.csi(ch, this.params); }
          continue;
        case 3:   // OSC: up to BEL or ESC \
          if (code === 7) this.state = 0; else if (code === 27) this.state = 5;
          continue;
        case 4: case 5: this.state = 0; continue;
      }
      if (code === 27) this.state = 1;
      else if (ch === '\r') this.col = 0;
      else if (ch === '\n') this.newline();
      else if (ch === '\b') this.col = Math.max(0, this.col - 1);
      else if (ch === '\t') { var to = (Math.floor(this.col / 8) + 1) * 8; while (this.col < to) this.put(' '); }
      else if (code < 0x20 || code === 0x7f) { /* bell and other controls: nothing to draw */ }
      else this.put(ch);
    }
    this.version++;
  };

  Screen.prototype.text = function () {
    return this.lines.map(function (l) { return l.join('').replace(/\s+$/, ''); }).join('\n').replace(/\n+$/, '');
  };

  function esc(s) { return s.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // The screen as HTML, with the cursor drawn when cursor is true.
  Screen.prototype.html = function (cursor) {
    var self = this;
    return this.lines.map(function (l, r) {
      var s = l.join('');
      if (!cursor || r !== self.row) return esc(s);
      while (s.length < self.col) s += ' ';
      var at = s.charAt(self.col) || ' ';
      return esc(s.slice(0, self.col)) + '<span class="fl-cur">' + esc(at) + '</span>' + esc(s.slice(self.col + 1));
    }).join('\n');
  };

  /* The bytes a terminal sends for a keydown, or null to let the browser handle it.
     e: { key, ctrlKey, altKey, metaKey, shiftKey }; selected: text is selected (Ctrl-C then copies). */
  var KEYS = {
    Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b',
    ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
    Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~'
  };
  function keyBytes(e, selected) {
    if (e.metaKey) return null;
    if (e.ctrlKey && !e.altKey) {
      var k = (e.key || '').toLowerCase();
      if (k.length !== 1) return KEYS[e.key] || null;
      if ((k === 'c' && selected) || k === 'v' || e.shiftKey) return null;   // copy, paste, and the browser's own
      if (k >= 'a' && k <= 'z') return String.fromCharCode(k.charCodeAt(0) & 0x1f);
      return null;
    }
    if (KEYS[e.key]) return KEYS[e.key];
    if (e.key && e.key.length === 1 && !e.altKey) return e.key;
    return null;
  }

  FL.term = { Screen: Screen, keyBytes: keyBytes, ROWS: ROWS };
})(window.FL = window.FL || {});
