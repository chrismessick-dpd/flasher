/* A Cortex-M target behind a probe (stlink.js or jlink.js): connect, halt, run, reset, core registers,
   and which STM32 it is. Memory goes through the access port the core sits on: AP0 on most STM32s, AP1
   for the STM32H5's Cortex-M33 (its AP0 reaches only the DBGMCU and the ROM table). */
(function () {
  'use strict';
  var FL = window.FL = window.FL || {};

  var CPUID = 0xE000ED00, AIRCR = 0xE000ED0C, DHCSR = 0xE000EDF0, DCRSR = 0xE000EDF4, DCRDR = 0xE000EDF8, DEMCR = 0xE000EDFC;
  var DBGKEY = 0xA05F0000, C_DEBUGEN = 1, C_HALT = 2, C_STEP = 4, C_MASKINTS = 8;
  var S_REGRDY = 1 << 16, S_HALT = 1 << 17, S_SLEEP = 1 << 18, S_LOCKUP = 1 << 19, S_RESET_ST = 1 << 25;
  var VC_CORERESET = 1;
  var CORES = { 0xC20: 'Cortex-M0', 0xC60: 'Cortex-M0+', 0xC23: 'Cortex-M3', 0xC24: 'Cortex-M4', 0xC27: 'Cortex-M7', 0xD20: 'Cortex-M23', 0xD21: 'Cortex-M33', 0xD22: 'Cortex-M55', 0xD23: 'Cortex-M85' };
  var REGS = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'SP', 'LR', 'PC', 'xPSR', 'MSP', 'PSP'];
  var REG_SEL = { xPSR: 16, MSP: 17, PSP: 18 };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function hex(v, n) { return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(n || 8, '0'); }

  function Target(probe, opts) {
    this.probe = probe;
    this.opts = opts || {};
    this.sleep = this.opts.sleep || sleep;
    this.log = this.opts.log || function () {};
    this.ap = 0;
    this.chip = null;      // from FL.stm32.identify
    this.haltedByUs = false;
    this.touched = false;  // this session switched debug on (DHCSR C_DEBUGEN): Disconnect switches it off
  }

  Target.prototype.r32 = function (a) { return this.probe.read32(this.ap, a); };
  Target.prototype.w32 = function (a, v) { return this.probe.write32(this.ap, a, v); };
  Target.prototype.read = function (a, n) { return this.probe.read(this.ap, a, n); };
  Target.prototype.write = function (a, b, o) { return this.probe.write(this.ap, a, b, o); };

  // Which AP answers with a Cortex-M CPUID. Returns null if none does (e.g. while the chip is held in reset).
  Target.prototype.findAp = async function () {
    for (var ap = 0; ap < 2; ap++) {
      try {
        var id = await this.probe.read32(ap, CPUID);
        if (((id >>> 24) & 0xFF) === 0x41 && CORES[(id >>> 4) & 0xFFF]) { this.ap = ap; this.cpuid = id; return ap; }
      } catch (e) { /* not this one */ }
    }
    return null;
  };

  /* Connect. underReset (the default for a flasher): hold NRST low, set the core to stop at its first
     instruction, then let go, so the application never runs. Hot plug: attach and read only; the core is
     not halted or touched. */
  Target.prototype.connect = async function (o) {
    o = o || {};
    var p = this.probe;
    var khz = await p.connect({ khz: o.khz, underReset: o.underReset });
    this.log('SWD at ' + khz + ' kHz' + (o.underReset ? ', NRST held low' : ', hot plug'));
    var ap = await this.findAp();
    if (o.underReset) {
      if (ap !== null) {
        try { await this.w32(DEMCR, VC_CORERESET); await this.w32(DHCSR, DBGKEY | C_DEBUGEN | C_HALT); }
        catch (e) { this.log('Could not set the reset catch while in reset: ' + e.message); }
      }
      if (ap !== null) this.touched = true;
      await p.nrst('high');
      await this.sleep(20);
      if (ap === null) ap = await this.findAp();
      if (ap === null) throw new Error('No Cortex-M core answered on access port 0 or 1. Is the target powered, and are SWDIO, SWCLK, GND, and NRST wired?');
      var s = await this.r32(DHCSR);
      // S_RESET_ST says a reset happened since DHCSR was last read: without it, NRST didn't reach the chip.
      if (!(s & S_RESET_ST)) this.log('NRST seems to have had no effect: is it wired to the probe? Halting and resetting from the debugger instead.');
      if (!(s & S_HALT) || !(s & S_RESET_ST)) { if (s & S_HALT) this.log('The core was stopped where it was running, not at reset.'); else this.log('The core was not stopped at reset; halting and resetting it from the debugger.'); await this.resetHalt(); }
      await this.w32(DEMCR, 0);
      this.haltedByUs = true;
    } else if (ap === null) {
      throw new Error('No Cortex-M core answered on access port 0 or 1. Is the target powered and wired? If its firmware turns off the SWD pins, use Under reset.');
    }
    this.log('Core ' + (CORES[(this.cpuid >>> 4) & 0xFFF] || '?') + ' on AP' + this.ap + ', CPUID ' + hex(this.cpuid));
    this.chip = FL.stm32 ? await FL.stm32.identify(this) : null;
    return this.chip;
  };

  Target.prototype.status = async function () {
    var s = await this.r32(DHCSR);
    return { halted: !!(s & S_HALT), sleeping: !!(s & S_SLEEP), lockup: !!(s & S_LOCKUP), debug: !!(s & C_DEBUGEN), raw: s };
  };
  Target.prototype.waitHalt = async function (ms) {
    var t0 = Date.now();
    for (;;) {
      if ((await this.r32(DHCSR)) & S_HALT) return true;
      if (Date.now() - t0 > (ms || 500)) return false;
      await this.sleep(2);
    }
  };
  Target.prototype.halt = async function () {
    this.touched = true;
    await this.w32(DHCSR, DBGKEY | C_DEBUGEN | C_HALT);
    if (!(await this.waitHalt(500))) throw new Error('The core did not halt.');
    this.haltedByUs = true;
  };
  // Run, leaving debug on (breakpoints and halts still work).
  Target.prototype.run = async function () {
    this.touched = true;
    await this.w32(DHCSR, DBGKEY | C_DEBUGEN);
    this.haltedByUs = false;
  };
  // Let go entirely: debug off, so the application runs as if no probe were there.
  Target.prototype.release = async function () {
    await this.w32(DEMCR, 0);
    await this.w32(DHCSR, DBGKEY);
    this.haltedByUs = false;
    this.touched = false;
  };
  Target.prototype.sysreset = async function () {
    try { await this.w32(AIRCR, 0x05FA0004); } catch (e) { /* the reset can cut the write's reply */ }
    await this.sleep(20);
  };
  // Reset and stop at the first instruction.
  Target.prototype.resetHalt = async function () {
    this.touched = true;
    await this.w32(DHCSR, DBGKEY | C_DEBUGEN | C_HALT);
    await this.w32(DEMCR, VC_CORERESET);
    await this.sysreset();
    var ok = await this.waitHalt(1000);
    await this.w32(DEMCR, 0);
    if (!ok) throw new Error('The core did not stop after the reset.');
    this.haltedByUs = true;
  };
  // Reset and run with debug off. hard: pulse NRST instead of a software reset.
  Target.prototype.resetRun = async function (hard) {
    await this.release();
    if (hard) { await this.probe.nrst('pulse'); await this.sleep(20); } else await this.sysreset();
  };

  // Core registers (the core must be halted).
  Target.prototype.readReg = async function (name) {
    var sel = REG_SEL[name] !== undefined ? REG_SEL[name] : REGS.indexOf(name);
    await this.w32(DCRSR, sel);
    for (var i = 0; i < 50; i++) { if ((await this.r32(DHCSR)) & S_REGRDY) return this.r32(DCRDR); }
    throw new Error('The core did not return ' + name + '.');
  };
  Target.prototype.writeReg = async function (name, v) {
    var sel = REG_SEL[name] !== undefined ? REG_SEL[name] : REGS.indexOf(name);
    await this.w32(DCRDR, v >>> 0);
    await this.w32(DCRSR, sel | 0x10000);
    for (var i = 0; i < 50; i++) { if ((await this.r32(DHCSR)) & S_REGRDY) return; }
    throw new Error('The core did not take ' + name + '.');
  };
  Target.prototype.readRegs = async function () {
    var out = {};
    for (var i = 0; i < REGS.length; i++) out[REGS[i]] = await this.readReg(REGS[i]);
    return out;
  };

  FL.target = { Target: Target, CORES: CORES, REGS: REGS, hex: hex, ADDR: { CPUID: CPUID, AIRCR: AIRCR, DHCSR: DHCSR, DCRSR: DCRSR, DCRDR: DCRDR, DEMCR: DEMCR } };
})();
