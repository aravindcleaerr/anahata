// Anahata web app: live ECG and breathing from the chest ECG board over Bluetooth.
(function () {
  'use strict';

  const VERSION = '0.2.1';
  const D = window.AnahataDSP;
  const BOARD_NAME = 'AiiraECG';
  const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';  // to the board
  const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';  // from the board
  const POSES = ['Rest', 'Tadasana', 'Forward fold', 'Downward dog', 'Cobra', 'Seated twist',
                 "Child's pose", 'Slow breathing', 'Savasana'];
  const COLORS = { ecg: '#5BD68A', resp: '#E8B45A', grid: '#1B2A22', gridBold: '#25362D',
                   text: '#8DA397', mark: '#9CC9FF', beat: '#E4EEE8', warn: '#FF6E5E', muted: '#8DA397' };

  const $ = id => document.getElementById(id);
  const ui = {};
  ['source', 'btnConnect', 'btnDisconnect', 'noBle', 'hr', 'br', 'status', 'statusNote', 'elapsed', 'lost',
   'ecgCanvas', 'respCanvas', 'ecgTitle', 'respTitle', 'btnRecord', 'btnSummary', 'btnSave', 'btnDemo',
   'btnOpen', 'file', 'label', 'poses', 'note', 'version', 'summaryDialog', 'summaryTitle', 'summaryTable',
   'btnCopy', 'btnClose', 'autoScale', 'ecgRange', 'btnClear'].forEach(id => { ui[id] = $(id); });

  // ------------------------------------------------------------ sweep trace
  class Sweep {
    constructor(canvas, color, minSpan, unit) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.color = color;
      this.minSpan = minSpan;
      this.unit = unit;
      this.auto = true;
      this.fixed = false;  // true while a fixed range is chosen
      this.configure(250, 10);
    }
    configure(fs, span) {
      this.fs = fs;
      this.span = span;
      this.n = Math.floor(span * fs);
      this.count = 0;
      this.lo = -this.minSpan / 2;
      this.hi = this.minSpan / 2;
      this.clear();
    }
    // Wipe the trace and marks; the pen starts again from the left edge.
    clear() {
      this.origin = this.count;
      this.ys = new Float32Array(this.n).fill(NaN);
      this.beats = [];  // [sample number, value]
      this.flags = [];  // [sample number, text]
    }
    setRange(half) {
      this.lo = -half;
      this.hi = half;
      this.fixed = true;
    }
    pos(sampleNo) { return ((sampleNo - this.origin) % this.n + this.n) % this.n; }
    add(v) {
      this.ys[this.pos(this.count)] = v;
      this.count++;
    }
    fit() {
      // With auto scale off the scale stays put. A held scale is still fitted over the
      // first part of a sweep, so a trace that has just started comes into view.
      const settling = !this.fixed && (this.count - this.origin) < 0.2 * this.n;
      if (!this.auto && !settling) return;
      let lo = Infinity, hi = -Infinity, seen = 0;
      for (let k = 0; k < this.n; k++) {
        const v = this.ys[k];
        if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; seen++; }
      }
      if (seen < this.fs) return;
      const span = Math.max(hi - lo, this.minSpan);
      const mid = (hi + lo) / 2;
      const wantLo = mid - 0.62 * span, wantHi = mid + 0.62 * span;
      if (lo < this.lo || hi > this.hi || (this.hi - this.lo) > 1.8 * (wantHi - wantLo)) {
        this.lo = wantLo; this.hi = wantHi;
      }
    }
    draw() {
      const c = this.canvas, ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
      if (!w || !h) return;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      ctx.clearRect(0, 0, w, h);
      const left = 44 * dpr, top = 32 * dpr, bottom = 8 * dpr;
      const pw = w - left, ph = h - top - bottom;
      const X = i => left + (i / this.n) * pw;
      const Y = v => top + (1 - (v - this.lo) / (this.hi - this.lo)) * ph;

      // grid: ten divisions across, value lines on a round step
      ctx.lineWidth = 1;
      for (let k = 0; k <= 10; k++) {
        ctx.strokeStyle = k % 5 === 0 ? COLORS.gridBold : COLORS.grid;
        const x = Math.round(left + k / 10 * pw) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke();
      }
      const range = this.hi - this.lo;
      const rough = range / 5;
      const pow = Math.pow(10, Math.floor(Math.log10(rough)));
      const step = [1, 2, 5, 10].map(m => m * pow).find(s => s >= rough);
      ctx.fillStyle = COLORS.text;
      ctx.font = (11 * dpr) + 'px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let v = Math.ceil(this.lo / step) * step; v <= this.hi; v += step) {
        const y = Math.round(Y(v)) + 0.5;
        ctx.strokeStyle = Math.abs(v) < step / 2 ? COLORS.gridBold : COLORS.grid;
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.fillText(String(Math.round(v)), left - 6 * dpr, y);
      }

      // trace, with a gap ahead of the pen
      const gap = Math.max(1, Math.floor(0.25 * this.fs));
      const pen = this.pos(this.count);
      const drawn = this.count - this.origin;
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1.6 * dpr;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let down = false;
      for (let k = 0; k < this.n; k++) {
        const ahead = (k - pen + this.n) % this.n;
        const v = this.ys[k];
        if (v !== v || (drawn > this.n && ahead < gap) || (drawn <= this.n && k >= pen && drawn < this.n)) { down = false; continue; }
        const x = X(k), y = Math.min(top + ph, Math.max(top, Y(v)));
        if (down) ctx.lineTo(x, y); else { ctx.moveTo(x, y); down = true; }
      }
      ctx.stroke();

      const oldest = Math.max(this.origin - 1, this.count - this.n + gap);
      this.beats = this.beats.filter(b => b[0] > oldest);
      this.flags = this.flags.filter(f => f[0] > oldest);
      ctx.fillStyle = COLORS.beat;
      for (const b of this.beats) {
        const x = X(this.pos(b[0]));
        const y = Math.max(top + 7 * dpr, Y(b[1]) - 6 * dpr);
        ctx.beginPath();
        ctx.moveTo(x - 4 * dpr, y - 7 * dpr); ctx.lineTo(x + 4 * dpr, y - 7 * dpr); ctx.lineTo(x, y);
        ctx.closePath(); ctx.fill();
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (const f of this.flags) {
        const x = Math.round(X(this.pos(f[0]))) + 0.5;
        ctx.strokeStyle = COLORS.mark;
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COLORS.mark;
        ctx.fillText(f[1], Math.min(x + 4 * dpr, w - 90 * dpr), top + 2 * dpr);
      }
    }
  }

  // ------------------------------------------------------------ state
  const ecgPlot = new Sweep(ui.ecgCanvas, COLORS.ecg, 400, 'µV');
  const respPlot = new Sweep(ui.respCanvas, COLORS.resp, 20, 'relative');
  let pipe = null;
  let source = null;      // {kind: 'ble' | 'demo' | 'file', live, title, stop()}
  let markers = [];       // [time s, text] in this session
  let pendingMark = '';
  let rec = null;         // {start, end, fs, label, rows: [[ecg, resp, mark]]}
  let lost = 0;
  let wakeLock = null;
  let lastSummary = null;

  function say(text) { ui.note.textContent = text || ''; }

  function applyScale() {
    const auto = ui.autoScale.checked;
    ui.ecgRange.disabled = auto;
    ecgPlot.auto = respPlot.auto = auto;
    ecgPlot.fixed = false;
    const half = parseFloat(ui.ecgRange.value);
    if (!auto && half) ecgPlot.setRange(half);
  }

  function clearTraces() {
    ecgPlot.clear();
    respPlot.clear();
  }

  function spans() {
    const wide = ui.ecgCanvas.clientWidth >= 640;
    return { ecg: wide ? 10 : 5, resp: wide ? 60 : 30 };
  }

  function begin(fs, src) {
    if (source && source.stop) source.stop();
    stopRecording(true);
    source = src;
    pipe = new D.Pipeline(fs);
    markers = [];
    pendingMark = '';
    lost = 0;
    rec = null;
    lastSummary = null;
    const s = spans();
    ecgPlot.configure(fs, s.ecg);
    respPlot.configure(fs, s.resp);
    applyScale();
    ui.ecgTitle.textContent = 'ECG · µV · ' + s.ecg + ' s sweep';
    ui.respTitle.textContent = 'Respiration · ' + s.resp + ' s sweep';
    ui.source.textContent = src.title + ' · ' + fs + ' samples/s';
    ui.btnRecord.disabled = !src.live;
    ui.btnSummary.disabled = false;
    ui.btnSave.disabled = true;
    ui.btnConnect.hidden = src.kind === 'ble';
    ui.btnDisconnect.hidden = src.kind !== 'ble';
    setPoses(src.live);
    say(src.live ? '' : (src.kind === 'demo' ? 'This is a made-up signal, not a person.' : 'Replaying a saved recording.'));
    keepAwake(true);
  }

  function idle(message) {
    if (source && source.stop) source.stop();
    stopRecording(true);
    source = null;
    ui.source.textContent = 'Connect to the board, or try the demo signal';
    ui.btnConnect.hidden = false;
    ui.btnDisconnect.hidden = true;
    ui.btnRecord.disabled = true;
    setPoses(false);
    ui.hr.textContent = '--';
    ui.br.textContent = '--';
    setStatus('Idle', COLORS.muted, '');
    say(message || '');
    keepAwake(false);
  }

  function take(ecg, resp, flags, mark) {
    if (!pipe) return;
    if (pendingMark) { mark = pendingMark; pendingMark = ''; }
    const n = pipe.n;
    const out = pipe.step(ecg, resp, flags);
    const quiet = n < 0.6 * pipe.fs;  // the filters' first swing is not signal
    ecgPlot.add(quiet ? NaN : out.ecg);
    respPlot.add(quiet ? NaN : out.resp);
    if (out.beat && !quiet && out.beat.index >= ecgPlot.origin) {
      const v = ecgPlot.ys[ecgPlot.pos(out.beat.index)];
      if (v === v) ecgPlot.beats.push([out.beat.index, out.beat.sign > 0 ? v : ecgPlot.hi]);
    }
    if (mark) {
      markers.push([n / pipe.fs, mark]);
      ecgPlot.flags.push([n, mark]);
      respPlot.flags.push([n, mark]);
    }
    if (rec && rec.end === null) rec.rows.push([ecg, resp, mark || '']);
  }

  // ------------------------------------------------------------ Bluetooth
  async function connectBle() {
    if (!navigator.bluetooth) { ui.noBle.hidden = false; return; }
    let device;
    try {
      say('Choose ' + BOARD_NAME + ' in the list.');
      device = await navigator.bluetooth.requestDevice({ filters: [{ name: BOARD_NAME }], optionalServices: [NUS] });
    } catch (err) {
      say(err && err.name === 'NotFoundError' ? 'No board was chosen.' : 'Bluetooth is not available: ' + err.message);
      return;
    }
    await openBle(device, true);
  }

  // Runs one step of connecting, names it on the screen, and gives up after a set time.
  function step(text, promise, seconds) {
    say(text);
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('no response after ' + seconds + ' s');
        err.stage = text;
        reject(err);
      }, seconds * 1000);
    });
    return Promise.race([promise, limit]).then(
      v => { clearTimeout(timer); return v; },
      e => { clearTimeout(timer); if (!e.stage) e.stage = text; throw e; });
  }

  async function openBle(device, fresh) {
    const parser = new D.Parser();
    let info = null, uvPerCount = 0, expect = null, closed = false, rx = null;
    const state = { kind: 'ble', live: true, title: BOARD_NAME + ' over Bluetooth', stop: () => {
      closed = true;
      try { if (rx) rx.writeValueWithoutResponse(new Uint8Array([0x74])).catch(() => {}); } catch (e) { /* link already gone */ }
      try { if (device.gatt.connected) device.gatt.disconnect(); } catch (e) { /* link already gone */ }
    } };

    const onData = event => {
      const v = event.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      for (const f of parser.feed(bytes)) {
        if (f.type === D.TYPE_INFO) { info = D.decodeInfo(f.payload); }
        else if (f.type === D.TYPE_DATA && uvPerCount && source === state) {
          const d = D.decodeData(f.payload);
          if (expect !== null && d.index > expect) lost += d.index - expect;
          expect = d.index + d.samples.length;
          for (const s of d.samples) take(s[0] * uvPerCount, s[1] / 16, d.flags, '');
        }
      }
    };

    try {
      let server;
      try {
        server = await step('Step 1 of 4: connecting to the board…', device.gatt.connect(), 12);
      } catch (first) {  // Android sometimes needs a second attempt
        try { device.gatt.disconnect(); } catch (e) { /* nothing to drop */ }
        await new Promise(r => setTimeout(r, 1000));
        server = await step('Step 1 of 4: connecting to the board, second attempt…', device.gatt.connect(), 15);
      }
      const service = await step('Step 2 of 4: finding the data service…', server.getPrimaryService(NUS), 12);
      const tx = await step('Step 2 of 4: finding the data service…', service.getCharacteristic(NUS_TX), 8);
      rx = await step('Step 2 of 4: finding the data service…', service.getCharacteristic(NUS_RX), 8);
      tx.addEventListener('characteristicvaluechanged', onData);
      await step('Step 3 of 4: switching on the data stream…', tx.startNotifications(), 10);
      await step('Step 3 of 4: switching on the data stream…', rx.writeValueWithResponse(new Uint8Array([0x62])), 8);  // 'b': frames
      await step('Step 4 of 4: waiting for the board to answer…', rx.writeValueWithResponse(new Uint8Array([0x69])), 8);  // 'i': info
      for (let k = 0; k < 40 && !info; k++) {
        if (k === 15) rx.writeValueWithResponse(new Uint8Array([0x69])).catch(() => {});  // ask once more
        await new Promise(r => setTimeout(r, 100));
      }
      if (!info || !parseFloat(info.fs) || !parseFloat(info.uv_per_count)) {
        device.gatt.disconnect();
        say('Step 4 of 4 failed: the board connected but did not answer. Load the Anahata firmware onto it.');
        return;
      }
      state.title = (info.name || BOARD_NAME) + ' over Bluetooth · firmware ' + (info.fw || '?');
      const fs = parseFloat(info.fs);
      if (fresh || !pipe || pipe.fs !== fs) begin(fs, state);
      else { source = state; ui.source.textContent = state.title + ' · ' + fs + ' samples/s'; say('Reconnected.'); }
      uvPerCount = parseFloat(info.uv_per_count);
    } catch (err) {
      try { device.gatt.disconnect(); } catch (e) { /* nothing to drop */ }
      say((err.stage ? err.stage.replace('…', '') + ' failed: ' : 'The connection failed: ') + err.message +
          '. Close other apps that use the board, switch the phone\'s Bluetooth off and on, then press Connect.');
      return;
    }

    device.addEventListener('gattserverdisconnected', async () => {
      if (closed || source !== state) return;
      setStatus('Disconnected', COLORS.warn, '');
      ui.hr.textContent = '--';
      ui.br.textContent = '--';
      for (let attempt = 1; attempt <= 5 && !closed && source === state; attempt++) {
        say('Connection lost. Trying again (' + attempt + ' of 5)…');
        await new Promise(r => setTimeout(r, 1500));
        try { await device.gatt.connect(); await openBle(device, false); return; } catch (e) { /* try again */ }
      }
      if (!closed && source === state) idle('Connection lost. Press Connect to start again.');
    }, { once: true });
  }

  // ------------------------------------------------------------ demo and replay
  function timed(fs, title, kind, next, total) {
    let timer = null, last = performance.now(), credit = 0, pos = 0;
    const state = { kind: kind, live: false, title: title, stop: () => clearInterval(timer) };
    begin(fs, state);
    timer = setInterval(() => {
      const now = performance.now();
      credit += Math.min(now - last, 250) / 1000 * fs;
      last = now;
      let n = Math.floor(credit);
      credit -= n;
      while (n-- > 0) {
        if (total !== null && pos >= total) {
          clearInterval(timer);
          say('End of recording. Open it again to replay, or press Summary for the figures.');
          return;
        }
        const s = next(pos++);
        take(s[0], s[1], null, s[2] || '');
      }
    }, 30);
  }

  function startDemo() {
    const demo = new D.DemoSignal(250);
    timed(250, 'Demo signal', 'demo', () => demo.next(), null);
  }

  function parseRecording(text) {
    const rows = text.split(/\r?\n/).filter(l => l.trim());
    const meta = {};
    let head = null;
    const t = [], ecg = [], resp = [], marks = [];
    for (const line of rows) {
      if (line.startsWith('#')) {
        const k = line.indexOf(':');
        if (k > 0) meta[line.slice(1, k).trim()] = line.slice(k + 1).trim();
        continue;
      }
      const p = line.split(',');
      if (!head) { head = p.map(s => s.trim()); continue; }
      const iT = head.indexOf('t_s') >= 0 ? head.indexOf('t_s') : head.indexOf('ms');
      const e = parseFloat(p[head.indexOf('ecg_uV')]);
      const tv = parseFloat(p[iT]);
      if (isNaN(e) || isNaN(tv)) continue;
      t.push(head.indexOf('t_s') >= 0 ? tv : tv / 1000);
      ecg.push(e);
      const r = parseFloat(p[head.indexOf('resp')]);
      resp.push(isNaN(r) ? 0 : r);
      const m = head.indexOf('marker');
      marks.push(m >= 0 && p[m] ? p.slice(m).join(',').trim() : '');
    }
    if (!head || head.indexOf('ecg_uV') < 0 || ecg.length < 10) throw new Error('This file is not an ECG recording.');
    let fs = parseFloat(meta.sample_rate_hz);
    if (!fs) {
      fs = (t.length - 1) / (t[t.length - 1] - t[0]);
      for (const nominal of [125, 250, 500, 1000]) if (Math.abs(fs - nominal) / nominal < 0.02) fs = nominal;
    }
    return { fs: fs, ecg: ecg, resp: resp, marks: marks };
  }

  function openFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const r = parseRecording(String(reader.result));
        timed(r.fs, file.name, 'file', i => [r.ecg[i], r.resp[i], r.marks[i]], r.ecg.length);
      } catch (err) { say(err.message); }
    };
    reader.onerror = () => say('The file could not be read.');
    reader.readAsText(file);
  }

  // ------------------------------------------------------------ recording, marks, summary
  function setPoses(on) {
    ui.poses.querySelectorAll('button').forEach(b => { b.disabled = !on; });
  }

  function toggleRecording() {
    if (rec && rec.end === null) { stopRecording(false); showSummary(); return; }
    if (!source || !source.live || !pipe) return;
    rec = { start: pipe.time, end: null, fs: pipe.fs, label: ui.label.value.trim(), rows: [],
            when: new Date(), source: source.title };
    ui.btnRecord.textContent = 'Stop recording';
    ui.btnRecord.setAttribute('aria-pressed', 'true');
    ui.btnSave.disabled = true;
    say('Recording. Press a pose button at the start of each pose.');
  }

  function stopRecording(silent) {
    if (!rec || rec.end !== null) return;
    rec.end = pipe ? pipe.time : rec.start;
    ui.btnRecord.textContent = 'Start recording';
    ui.btnRecord.setAttribute('aria-pressed', 'false');
    ui.btnSave.disabled = rec.rows.length === 0;
    if (!silent) say('Recording stopped. Press Save recording to keep the file.');
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function recordingFile() {
    const d = rec.when;
    const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' +
                  pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    const safe = rec.label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    const lines = ['# recorded: ' + stamp.replace('_', ' '), '# label: ' + rec.label,
                   '# sample_rate_hz: ' + rec.fs, '# program: Anahata web ' + VERSION,
                   '# source: ' + rec.source, 't_s,ecg_uV,resp,marker'];
    rec.rows.forEach((r, i) => lines.push((i / rec.fs).toFixed(3) + ',' + r[0].toFixed(1) + ',' + r[1].toFixed(1) + ',' + r[2]));
    return new File([lines.join('\n') + '\n'], stamp + (safe ? '_' + safe : '') + '.csv', { type: 'text/csv' });
  }

  async function saveRecording() {
    if (!rec || !rec.rows.length) return;
    const file = recordingFile();
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: file.name }); say('Shared ' + file.name); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    say('Saved ' + file.name + ' to the downloads folder.');
  }

  function fmt(v) { return v === null || v === undefined ? '–' : String(Math.round(v)); }

  function showSummary() {
    if (!pipe) return;
    let start = 0, end = pipe.time, name = 'Whole session';
    if (rec) { start = rec.start; end = rec.end === null ? pipe.time : rec.end; name = 'Recording'; }
    if (end - start < 5) { say('A summary needs at least five seconds of signal.'); return; }
    const s = D.summary(start, end, pipe.beatLog, pipe.breath.log, markers, name);
    const rows = [s.overall].concat(s.poses);
    const head = ['Part', 'Duration', 'Beats', 'HR avg', 'HR min', 'HR max', 'Breaths/min'];
    const body = rows.map(r => [r.name, Math.round(r.duration) + ' s', String(r.beats), fmt(r.hrAvg), fmt(r.hrMin),
                                fmt(r.hrMax), fmt(r.breaths)]);
    const table = ui.summaryTable;
    table.textContent = '';
    const tr = table.insertRow();
    head.forEach(h => { const th = document.createElement('th'); th.textContent = h; tr.appendChild(th); });
    body.forEach(r => { const row = table.insertRow(); r.forEach(c => { row.insertCell().textContent = c; }); });
    const title = (source ? source.title : '') + ' · ' + new Date().toLocaleString();
    ui.summaryTitle.textContent = title;
    lastSummary = ['Anahata session summary · ' + title, ''].concat([head].concat(body).map(r => r.join('\t')))
      .concat(['', 'Demonstration only. Not a medical device.']).join('\n');
    ui.summaryDialog.showModal();
  }

  // ------------------------------------------------------------ readouts
  function setStatus(text, color, note) {
    ui.status.textContent = text;
    ui.status.style.color = color;
    ui.statusNote.textContent = note || ' ';
  }

  function readouts() {
    if (!pipe || !source) return;
    const t = Math.floor(pipe.time);
    ui.elapsed.textContent = Math.floor(t / 60) + ':' + pad(t % 60);
    ui.lost.textContent = lost ? lost + ' samples lost' : ' ';
    if (ui.status.textContent === 'Disconnected' && source.kind === 'ble') return;
    const off = pipe.contactLost;
    const hr = off ? null : pipe.heartRate();
    const br = off ? null : pipe.breathRate();
    ui.hr.textContent = hr === null ? '--' : String(Math.round(hr));
    ui.br.textContent = br === null ? '--' : String(Math.round(br));
    if (off) {
      const red = pipe.flags & D.FLAG_MINUS_OFF, yellow = pipe.flags & D.FLAG_PLUS_OFF;
      const note = red && yellow ? 'Red and yellow leads, or green' : red ? 'Check the red lead'
                 : yellow ? 'Check the yellow lead' : 'No body between the electrodes';
      setStatus('No contact', COLORS.warn, note);
    } else if (pipe.time <= 5.5) {
      setStatus('Settling', COLORS.muted, '');
    } else {
      const s = pipe.signalStatus();
      if (s === 'good') setStatus('Good', COLORS.ecg, '');
      else if (s === 'noisy') setStatus('Noisy', COLORS.resp, '');
      else setStatus('No signal', COLORS.warn, '');
    }
  }

  function frame() {
    if (pipe) { ecgPlot.fit(); respPlot.fit(); }
    ecgPlot.draw();
    respPlot.draw();
    requestAnimationFrame(frame);
  }

  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* the screen may dim; nothing else is affected */ }
  }

  // ------------------------------------------------------------ wiring
  POSES.forEach(name => {
    const b = document.createElement('button');
    b.textContent = name;
    b.disabled = true;
    b.addEventListener('click', () => { pendingMark = name; });
    ui.poses.appendChild(b);
  });
  ui.autoScale.addEventListener('change', applyScale);
  ui.ecgRange.addEventListener('change', applyScale);
  ui.btnClear.addEventListener('click', clearTraces);
  ui.btnConnect.addEventListener('click', connectBle);
  ui.btnDisconnect.addEventListener('click', () => idle('Disconnected.'));
  ui.btnDemo.addEventListener('click', startDemo);
  ui.btnOpen.addEventListener('click', () => ui.file.click());
  ui.file.addEventListener('change', () => { if (ui.file.files[0]) openFile(ui.file.files[0]); ui.file.value = ''; });
  ui.btnRecord.addEventListener('click', toggleRecording);
  ui.btnSummary.addEventListener('click', showSummary);
  ui.btnSave.addEventListener('click', saveRecording);
  ui.btnClose.addEventListener('click', () => ui.summaryDialog.close());
  ui.btnCopy.addEventListener('click', () => {
    if (!lastSummary) return;
    navigator.clipboard.writeText(lastSummary).then(() => { ui.btnCopy.textContent = 'Copied'; },
                                                    () => { ui.btnCopy.textContent = 'Copy failed'; });
    setTimeout(() => { ui.btnCopy.textContent = 'Copy'; }, 1500);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && source) keepAwake(true);
  });

  ui.version.textContent = 'Anahata web ' + VERSION;
  if (!navigator.bluetooth) ui.noBle.hidden = false;
  setInterval(readouts, 250);
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (location.hash.indexOf('#demo') === 0) {  // '#demo', or '#demo-fixed' for a check of the view controls
    startDemo();
    if (location.hash === '#demo-fixed') {
      ui.autoScale.checked = false;
      ui.ecgRange.value = '1000';
      applyScale();
      setTimeout(clearTraces, 9000);
    }
  }
})();
