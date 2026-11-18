/* Flasher lab · passthrough. One player steps through a bridge board's update; three concepts draw it.
   The phases follow README, *Bridge boards*: a 2400-baud knock on the host's USB serial port, the host
   passes its USB through and holds the board in its bootloader, a CRC of every block, only the blocks that
   differ erased, written, and read back, then the 1200-baud exit restarts both boards. Made-up demo boards. */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };

  var HOST = 'Main PCBA', TARGET = 'Display & Sensor Board';
  var N = 24, DIFF = [3, 4, 5, 11, 17, 18];
  var PHASES = [
    { id: 'idle', label: 'Before', ms: 1800, text: '<b>Both boards run their own firmware.</b> The ' + TARGET + ' has no USB port, so the computer can’t reach it directly.' },
    { id: 'knock', label: 'Knock', ms: 1800, text: '<b>Flasher knocks.</b> It opens the ' + HOST + '’s USB serial port at 2400 baud, which asks it to pass its USB through.' },
    { id: 'bridge', label: 'Passthrough', ms: 2200, text: '<b>The ' + HOST + ' becomes a pipe.</b> It holds the ' + TARGET + ' in its bootloader, and whatever Flasher sends on USB goes out on the board cable.' },
    { id: 'compare', label: 'Compare', ms: 0, text: '<b>Flasher compares every block.</b> The board reports a checksum for each; ' + DIFF.length + ' of ' + N + ' differ from the new firmware.' },
    { id: 'write', label: 'Write', ms: 0, text: '<b>Only the blocks that differ are rewritten:</b> each is erased, written, and read back. The rest are left alone, so updates take seconds.' },
    { id: 'done', label: 'Done', ms: 0, text: '<b>Back to normal.</b> Flasher opens the port at 1200 baud; the ' + HOST + ' returns to its own firmware and restarts the ' + TARGET + ' on the new version.' }
  ];
  var S = { p: 0, cmp: 0, wr: 0, playing: false };
  var timer = null;

  function ph() { return PHASES[S.p].id; }
  function at(id) { return S.p >= PHASES.map(function (x) { return x.id; }).indexOf(id); }
  function usbOn() { return ['knock', 'bridge', 'compare', 'write', 'done'].indexOf(ph()) >= 0; }
  function uartOn() { return ['bridge', 'compare', 'write'].indexOf(ph()) >= 0; }
  function hostMode() { return ph() === 'knock' ? ['Knocked at 2400 baud', 'on'] : uartOn() ? ['Passthrough', 'on'] : ['Thermostat Firmware', '']; }
  function targetMode() { return uartOn() ? ['Bootloader', 'on'] : ph() === 'done' ? ['Display Firmware 1.4.0', 'new'] : ['Display Firmware 1.3.2', '']; }
  function pcStatus() { return ph() === 'knock' ? 'Knocking' : ph() === 'done' ? 'Saying goodbye' : usbOn() ? 'Talking to the display' : 'Chrome'; }
  function blockState(i) {
    var d = DIFF.indexOf(i);
    if (!at('compare') || (ph() === 'compare' && i >= S.cmp)) return 'unk';
    if (d < 0) return 'same';
    if (ph() === 'done' || (ph() === 'write' && d < S.wr)) return 'done';
    if (ph() === 'write' && d === S.wr) return 'now';
    return 'diff';
  }

  var IC = {
    pc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12" rx="1.8"/><path d="M1.5 19.5h21"/></svg>',
    host: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M1 10.5h2M1 13.5h2M21 12h2"/></svg>',
    target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="6" y="8" width="12" height="6" rx="1"/><path d="M1 12h2"/></svg>'
  };

  // ── A · Signal path ──
  function link(on, label, back) {
    return '<div class="pt-link"><svg viewBox="0 0 100 12" preserveAspectRatio="none"><path class="pt-wire' + (on ? ' on' : '') + '" d="M2 6H98" vector-effect="non-scaling-stroke"/>' +
      '<path class="pt-dash' + (on ? ' on' : '') + (back ? ' back' : '') + '" d="M2 6H98" vector-effect="non-scaling-stroke"/></svg><span class="pt-link-label' + (on ? ' on' : '') + '">' + label + '</span></div>';
  }
  function stop(icon, name, mode, on) {
    return '<div class="pt-stop"><div class="pt-node' + (on ? ' on' : '') + '">' + icon + '</div><div class="pt-name">' + name + '</div><div class="pt-mode ' + mode[1] + '">' + mode[0] + '</div></div>';
  }
  function drawA() {
    var hm = hostMode(), tm = targetMode();
    $('#pt-a').innerHTML = '<div class="pt-a">' +
      stop(IC.pc, 'This computer', ['Chrome, Flasher', usbOn() ? 'on' : ''], usbOn()) +
      link(usbOn(), ph() === 'knock' ? 'USB · 2400 baud' : ph() === 'done' ? 'USB · 1200 baud' : 'USB') +
      stop(IC.host, HOST, hm, hm[1] === 'on') +
      link(uartOn(), 'Board cable (UART)') +
      stop(IC.target, TARGET, tm, uartOn()) + '</div>';
  }

  // ── B · The bench ──
  function drawB() {
    var hm = hostMode(), tm = targetMode(), u = usbOn(), r = uartOn();
    var lcd = r ? 'BOOT' : ph() === 'done' ? '1.4.0 ✓' : '21.4 °C';
    var pads = '';
    for (var i = 0; i < 6; i++) { pads += '<rect class="pad" x="' + (282 + i * 7.5) + '" y="110" width="3.5" height="5"/><rect class="pad" x="' + (282 + i * 7.5) + '" y="161" width="3.5" height="5"/>'; }
    $('#pt-b').innerHTML = '<div class="pt-b"><svg viewBox="0 0 640 256" role="img" aria-label="The computer, the ' + HOST + ', and the ' + TARGET + ', joined by a USB cable and a board cable">' +
      // computer
      '<rect class="lap-screen" x="18" y="62" width="112" height="72" rx="6"/><text class="lap-text" x="74" y="102" text-anchor="middle">Flasher</text>' +
      '<path class="lap" d="M8 136h132l-8 10H16z"/>' +
      '<text class="label" x="74" y="228" text-anchor="middle">This computer</text><text class="sub' + (u ? ' on' : '') + '" x="74" y="244" text-anchor="middle">' + pcStatus() + '</text>' +
      // USB cable
      '<path class="pt-wire' + (u ? ' on' : '') + '" d="M120 136 C 170 136, 165 150, 207 150"/><path class="pt-dash' + (u ? ' on' : '') + '" d="M120 136 C 170 136, 165 150, 207 150"/>' +
      '<text class="sub" x="160" y="172" text-anchor="middle">USB</text>' +
      // host board
      '<rect class="pcb" x="215" y="80" width="190" height="130" rx="8"/><rect class="pcb-edge" x="219" y="84" width="182" height="122" rx="6"/>' +
      '<rect class="chip" x="280" y="115" width="46" height="46" rx="3"/>' + pads +
      '<rect class="chip" x="345" y="175" width="30" height="16" rx="2"/><rect class="chip" x="236" y="176" width="22" height="14" rx="2"/>' +
      '<rect class="conn" x="205" y="140" width="16" height="20" rx="2"/><rect class="conn" x="397" y="135" width="14" height="30" rx="2"/>' +
      '<circle class="led ' + (r ? 'busy' : 'on') + '" cx="388" cy="96" r="4"/>' +
      (hm[1] ? '<rect class="tag" x="250" y="66" width="120" height="20" rx="10"/><text class="tag-text" x="310" y="80" text-anchor="middle">' + (ph() === 'knock' ? 'KNOCK · 2400' : 'PASSTHROUGH') + '</text>' : '') +
      '<text class="label" x="310" y="228" text-anchor="middle">' + HOST + '</text><text class="sub' + (hm[1] ? ' on' : '') + '" x="310" y="244" text-anchor="middle">' + hm[0] + '</text>' +
      // board cable
      '<path class="pt-wire' + (r ? ' on' : '') + '" d="M411 150 C 432 196, 448 196, 466 150"/><path class="pt-dash' + (r ? ' on' : '') + '" d="M411 150 C 432 196, 448 196, 466 150"/>' +
      '<text class="sub" x="438" y="204" text-anchor="middle">UART</text>' +
      // target board
      '<rect class="pcb" x="472" y="78" width="150" height="128" rx="8"/><rect class="pcb-edge" x="476" y="82" width="142" height="120" rx="6"/>' +
      '<rect class="conn" x="464" y="135" width="12" height="30" rx="2"/>' +
      '<rect class="lcd" x="490" y="92" width="114" height="62" rx="3"/><text class="lcd-text" x="547" y="128" text-anchor="middle">' + lcd + '</text>' +
      '<rect class="chip" x="534" y="166" width="24" height="24" rx="2"/><circle class="led ' + (r ? 'busy' : 'on') + '" cx="606" cy="190" r="4"/>' +
      '<text class="label" x="547" y="228" text-anchor="middle">' + TARGET + '</text><text class="sub' + (r ? ' on' : '') + '" x="547" y="244" text-anchor="middle">' + tm[0] + (r ? '' : ' · no USB') + '</text>' +
      '</svg></div>';
  }

  // ── C · Compact line, block map ──
  function drawC() {
    var u = usbOn(), r = uartOn();
    var note = { idle: 'Updated through the ' + HOST + '’s USB', knock: 'Asking the ' + HOST + ' to pass through…', bridge: 'Connected to the display’s bootloader', compare: 'Comparing blocks… ' + Math.min(S.cmp, N) + ' of ' + N,
      write: 'Writing ' + Math.min(S.wr + 1, DIFF.length) + ' of ' + DIFF.length + ' changed blocks', done: DIFF.length + ' blocks rewritten, ' + (N - DIFF.length) + ' unchanged' }[ph()];
    var hm = hostMode(), tm = targetMode();
    function hop(on, icon, name, status, live) {
      return '<span class="hop' + (on ? ' on' : '') + '"><span class="hop-name">' + icon + name + '</span><span class="hop-status' + (live ? ' live' : '') + '">' + status + '</span></span>';
    }
    var h = '<div class="pt-c-row"><span class="pt-chain">' +
      hop(u, IC.pc, 'This computer', pcStatus(), u) + '<span class="via' + (u ? ' on' : '') + '"></span>' +
      hop(u || r, IC.host, HOST, hm[0], !!hm[1]) + '<span class="via' + (r ? ' on' : '') + '"></span>' +
      hop(r || ph() === 'done', IC.target, TARGET, tm[0] + (r ? '' : ' · no USB'), r) + '</span><span class="pt-chain-note">' + note + '</span></div>';
    h += '<div class="pt-blocks" id="pt-blocks">';
    for (var i = 0; i < N; i++) h += '<span class="pt-blk ' + blockState(i) + '" title="Block ' + (i + 1) + ' (4 KB)"></span>';
    h += '</div><div class="pt-legend"><b class="pt-legend-label">Flash block status:</b><span><i class="pt-blk unk"></i>Not checked yet</span><span><i class="pt-blk"></i>Same, left alone</span><span><i class="pt-blk diff"></i>Differs</span><span><i class="pt-blk done"></i>Rewritten and read back</span></div>';
    $('#pt-c').innerHTML = h;
  }

  function draw() {
    drawA(); drawB(); drawC();
    $('#pt-caption').innerHTML = PHASES[S.p].text;
    $('#pt-steps').innerHTML = PHASES.map(function (x, i) { return '<button data-p="' + i + '" class="' + (i === S.p ? 'on' : '') + '">' + (i + 1) + ' · ' + x.label + '</button>'; }).join('');
    $('#pt-play').textContent = S.playing ? 'Pause' : S.p === PHASES.length - 1 ? 'Play again' : 'Play';
  }

  function go(p) {
    S.p = p; S.cmp = p > 3 ? N : 0; S.wr = p > 4 ? DIFF.length : 0;
    if (!S.playing && p === 3) S.cmp = N;
    if (!S.playing && p === 4) S.wr = 2;
    draw();
  }
  function tick() {
    var x = PHASES[S.p];
    if (x.id === 'compare') { if (S.cmp < N) { S.cmp++; draw(); return later(90); } }
    else if (x.id === 'write') { if (S.wr < DIFF.length) { S.wr++; draw(); return later(520); } }
    if (S.p >= PHASES.length - 1) { S.playing = false; return draw(); }
    go(S.p + 1); later(PHASES[S.p].ms || 400);
  }
  function later(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }
  function play() {
    if (S.playing) { S.playing = false; clearTimeout(timer); return draw(); }
    S.playing = true;
    if (S.p === PHASES.length - 1) go(0); else draw();
    later(PHASES[S.p].ms || 400);
  }

  function setTheme(v) {
    document.documentElement.dataset.theme = v;
    try { localStorage.setItem('flasher.lab.layout.theme', v); } catch (e) { /* storage blocked */ }
    Array.prototype.forEach.call(document.querySelectorAll('#pt-theme button'), function (b) { b.classList.toggle('on', b.dataset.v === v); });
  }
  $('#pt-play').addEventListener('click', play);
  $('#pt-steps').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; S.playing = false; clearTimeout(timer); go(+b.dataset.p); });
  $('#pt-theme').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setTheme(b.dataset.v); });
  var saved = null; try { saved = localStorage.getItem('flasher.lab.layout.theme'); } catch (e) { /* storage blocked */ }
  setTheme(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  draw();
})();
