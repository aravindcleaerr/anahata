// Anahata signal processing. The same steps as Viewer/anahata/dsp.py, so the
// phone and the PC show the same figures. Works in a browser and in Node.
(function (root) {
  'use strict';

  const MAINS_HZ = 50;

  class Biquad {
    constructor(b0, b1, b2, a1, a2) {
      this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
    }
    static make(kind, fs, f0, q) {
      const w0 = 2 * Math.PI * f0 / fs;
      const alpha = Math.sin(w0) / (2 * q);
      const c = Math.cos(w0);
      const a0 = 1 + alpha;
      let b;
      if (kind === 'lowpass') b = [(1 - c) / 2, 1 - c, (1 - c) / 2];
      else if (kind === 'highpass') b = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
      else b = [1, -2 * c, 1];
      return new Biquad(b[0] / a0, b[1] / a0, b[2] / a0, -2 * c / a0, (1 - alpha) / a0);
    }
    prime(x) {  // start as if the input had always been x
      this.x1 = this.x2 = x;
      const gain = (this.b0 + this.b1 + this.b2) / (1 + this.a1 + this.a2);
      this.y1 = this.y2 = x * gain;
    }
    step(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x;
      this.y2 = this.y1; this.y1 = y;
      return y;
    }
  }

  class Chain {
    constructor(sections) { this.sections = sections; this.primed = false; }
    step(x) {
      if (!this.primed) {
        for (const s of this.sections) { s.prime(x); x = s.y1; }
        this.primed = true;
        return x;
      }
      for (const s of this.sections) x = s.step(x);
      return x;
    }
  }

  function ecgDisplayChain(fs) {
    const s = [Biquad.make('highpass', fs, 0.5, 0.7071)];
    if (fs > 2.4 * MAINS_HZ) s.push(Biquad.make('notch', fs, MAINS_HZ, 5), Biquad.make('notch', fs, MAINS_HZ, 5));
    if (fs > 2.4 * 2 * MAINS_HZ) s.push(Biquad.make('notch', fs, 2 * MAINS_HZ, 5));
    return new Chain(s);
  }

  function respDisplayChain(fs) {
    return new Chain([Biquad.make('highpass', fs, 0.08, 0.7071), Biquad.make('lowpass', fs, 1.0, 0.7071)]);
  }

  function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  }

  // Finds heartbeats in a stream (a compact Pan-Tompkins scheme).
  class BeatDetector {
    constructor(fs) {
      this.fs = fs;
      this.band = new Chain([Biquad.make('highpass', fs, 5, 0.7071),
                             Biquad.make('lowpass', fs, Math.min(20, 0.4 * fs), 0.7071)]);
      this.prev = 0;
      this.winLen = Math.max(1, Math.floor(0.12 * fs));
      this.win = new Array(this.winLen).fill(0);
      this.winPos = 0;
      this.winSum = 0;
      this.histLen = Math.floor(0.30 * fs) + 2;
      this.hist = [];  // [index, band value, display value]
      this.m1 = this.m2 = 0;
      this.spk = 0; this.npk = 0;
      this.learn = [];
      this.lastBeat = null;
      this.n = 0;
    }
    // Returns {index, height, sign} when a beat is found, else null.
    step(x) {
      const i = this.n++;
      const fs = this.fs;
      const b = this.band.step(x);
      const d = b - this.prev;
      this.prev = b;
      const sq = d * d;
      this.winSum += sq - this.win[this.winPos];
      this.win[this.winPos] = sq;
      this.winPos = (this.winPos + 1) % this.winLen;
      const m = this.winSum / this.winLen;
      this.hist.push([i, b, x]);
      if (this.hist.length > this.histLen) this.hist.shift();

      const isPeak = this.m1 > this.m2 && this.m1 >= m;
      const peak = this.m1;
      this.m2 = this.m1; this.m1 = m;

      if (i < 2 * fs) {  // learn the signal level over the first two seconds
        this.learn.push(m);
        if (i === Math.floor(2 * fs) - 1) {
          this.spk = 0.4 * Math.max.apply(null, this.learn);
          this.npk = this.learn.reduce((a, v) => a + v, 0) / this.learn.length * 0.5;
        }
        return null;
      }

      const thr = this.npk + 0.25 * (this.spk - this.npk);
      const since = this.lastBeat === null ? null : (i - this.lastBeat) / fs;
      if (since !== null && since > 2.0) this.spk *= 0.999;

      let found = null;
      if (isPeak) {
        if (peak > thr && (since === null || since > 0.25)) {
          this.spk = 0.125 * peak + 0.875 * this.spk;
          let best = this.hist[0];
          for (const h of this.hist) if (Math.abs(h[1]) > Math.abs(best[1])) best = h;
          const base = median(this.hist.map(h => h[2]));
          const reach = Math.floor(0.06 * fs);
          let top = null;
          for (const h of this.hist) {
            if (Math.abs(h[0] - best[0]) > reach) continue;
            if (top === null || Math.abs(h[2] - base) > Math.abs(top[2] - base)) top = h;
          }
          if (this.lastBeat === null || (top[0] - this.lastBeat) / fs > 0.25) {
            this.lastBeat = top[0];
            found = { index: top[0], height: Math.abs(top[2] - base), sign: top[2] >= base ? 1 : -1 };
          }
        } else {
          this.npk = 0.125 * peak + 0.875 * this.npk;
        }
      }
      return found;
    }
  }

  class HeartRate {
    constructor(nBeats) { this.max = nBeats || 8; this.rr = []; this.lastT = null; }
    addBeat(t) {
      if (this.lastT !== null) {
        const rr = t - this.lastT;
        if (rr >= 0.3 && rr <= 2.0) { this.rr.push(rr); if (this.rr.length > this.max) this.rr.shift(); }
        else if (rr > 2.0) this.rr = [];
      }
      this.lastT = t;
    }
    value(now) {
      if (this.lastT === null || now - this.lastT > 3.0 || this.rr.length < 2) return null;
      return 60 * this.rr.length / this.rr.reduce((a, v) => a + v, 0);
    }
  }

  class BreathRate {
    constructor(fs) {
      this.fs = fs;
      this.span = 30;
      this.len = Math.floor(this.span * fs);
      this.buf = new Float64Array(this.len);
      this.count = 0;
      this.cross = [];
      this.log = [];
      this.armed = false;
      this.level = null;
      this.n = 0;
    }
    step(y) {
      const t = this.n / this.fs;
      this.n++;
      this.buf[this.count % this.len] = y;
      this.count++;
      const have = Math.min(this.count, this.len);
      if (this.n % Math.max(1, Math.floor(this.fs / 10)) === 0 && have > 5 * this.fs) {
        let m = 0;
        for (let k = 0; k < have; k++) m += this.buf[k];
        m /= have;
        let v = 0;
        for (let k = 0; k < have; k++) v += (this.buf[k] - m) * (this.buf[k] - m);
        this.level = 0.3 * Math.sqrt(v / have);
      }
      if (this.level === null) return;
      if (y < -this.level) this.armed = true;
      else if (y > this.level && this.armed) {
        this.armed = false;
        this.cross.push(t);
        this.log.push(t);
      }
      while (this.cross.length && t - this.cross[0] > this.span) this.cross.shift();
    }
    value() {
      if (this.cross.length < 3) return null;
      const t = this.n / this.fs;
      if (t - this.cross[this.cross.length - 1] > 15) return null;
      const recent = this.cross.slice(-6);
      const gaps = [];
      for (let k = 1; k < recent.length; k++) gaps.push(recent[k] - recent[k - 1]);
      const mid = median(gaps);
      return mid > 0 ? 60 / mid : null;
    }
  }

  class SignalStatus {
    constructor(fs) {
      this.fs = fs;
      this.len = Math.floor(5 * fs);
      this.x = [];
      this.beats = [];
      this.n = 0;
    }
    step(x, beat) {
      this.x.push(x);
      if (this.x.length > this.len) this.x.shift();
      if (beat) this.beats.push(beat);
      this.n++;
      while (this.beats.length && this.n - this.beats[0].index > 5 * this.fs) this.beats.shift();
    }
    value(contactLost) {
      if (contactLost) return 'none';
      if (this.x.length < this.len || this.beats.length < 3) return 'none';
      const height = median(this.beats.map(b => b.height));
      const idx = this.beats.map(b => b.index);
      for (let k = 1; k < idx.length; k++) if ((idx[k] - idx[k - 1]) / this.fs < 0.3) return 'noisy';
      const start = this.n - this.x.length;
      const skip = new Uint8Array(this.x.length);
      for (const i of idx) {
        const a = Math.max(0, i - Math.floor(0.08 * this.fs) - start);
        const b = Math.min(this.x.length, i + Math.floor(0.35 * this.fs) - start);
        for (let k = a; k < b; k++) skip[k] = 1;
      }
      let m = 0, c = 0;
      for (let k = 0; k < this.x.length; k++) if (!skip[k]) { m += this.x[k]; c++; }
      if (c < this.fs) return 'noisy';
      m /= c;
      let v = 0;
      for (let k = 0; k < this.x.length; k++) if (!skip[k]) v += (this.x[k] - m) * (this.x[k] - m);
      const noise = Math.sqrt(v / c);
      if (noise <= 0) return 'good';
      return height / noise >= 4 ? 'good' : 'noisy';
    }
  }

  // Turns raw samples into what the screen shows.
  class Pipeline {
    constructor(fs) {
      this.fs = fs;
      this.ecgChain = ecgDisplayChain(fs);
      this.respChain = respDisplayChain(fs);
      this.beats = new BeatDetector(fs);
      this.heart = new HeartRate(8);
      this.breath = new BreathRate(fs);
      this.status = new SignalStatus(fs);
      this.n = 0;
      this.contactLost = false;
      this.flags = 0;
      this.respFlat = 0;
      this.lastResp = null;
      this.beatLog = [];  // [time s, height µV]
    }
    get time() { return this.n / this.fs; }
    // flags: the board's contact flags, or null when the source has none.
    step(ecgRaw, respRaw, flags) {
      const e = this.ecgChain.step(ecgRaw);
      const r = this.respChain.step(respRaw);
      const beat = this.beats.step(e);
      if (beat) {
        const t = beat.index / this.fs;
        this.heart.addBeat(t);
        this.beatLog.push([t, beat.height]);
      }
      this.breath.step(r);
      this.status.step(e, beat);
      if (respRaw === this.lastResp) this.respFlat++; else this.respFlat = 0;
      this.lastResp = respRaw;
      if (flags !== null && flags !== undefined) {
        this.flags = flags;
        this.contactLost = flags !== 0;
      } else {
        this.contactLost = this.respFlat > 2 * this.fs;
      }
      this.n++;
      return { ecg: e, resp: r, beat: beat };
    }
    heartRate() { return this.heart.value(this.time); }
    breathRate() { return this.contactLost ? null : this.breath.value(); }
    signalStatus() { return this.status.value(this.contactLost); }
  }

  // ---- the board's frame format (see Firmware/anahata_fw)
  const TYPE_DATA = 1, TYPE_INFO = 2, TYPE_STATUS = 3, FLAG_PLUS_OFF = 1, FLAG_MINUS_OFF = 2;

  class Parser {
    constructor() { this.buf = []; this.bad = 0; }
    feed(bytes) {
      for (let k = 0; k < bytes.length; k++) this.buf.push(bytes[k]);
      const frames = [];
      for (;;) {
        let start = -1;
        for (let k = 0; k + 1 < this.buf.length; k++) {
          if (this.buf[k] === 0xA5 && this.buf[k + 1] === 0x5A) { start = k; break; }
        }
        if (start < 0) { this.buf.splice(0, Math.max(0, this.buf.length - 1)); break; }
        if (start) this.buf.splice(0, start);
        if (this.buf.length < 5) break;
        const type = this.buf[2], len = this.buf[3];
        if (this.buf.length < 5 + len) break;
        let sum = 0;
        for (let k = 2; k < 4 + len; k++) sum += this.buf[k];
        if ((sum & 0xFF) !== this.buf[4 + len]) { this.bad++; this.buf.splice(0, 2); continue; }
        frames.push({ type: type, payload: this.buf.slice(4, 4 + len) });
        this.buf.splice(0, 5 + len);
      }
      return frames;
    }
  }

  function decodeInfo(payload) {
    const info = {};
    String.fromCharCode.apply(null, payload).split(';').forEach(part => {
      const k = part.indexOf('=');
      if (k > 0) info[part.slice(0, k).trim()] = part.slice(k + 1).trim();
    });
    return info;
  }

  function int24(p, i) {
    const v = p[i] | (p[i + 1] << 8) | (p[i + 2] << 16);
    return v & 0x800000 ? v - 0x1000000 : v;
  }

  function decodeStatus(p) {
    const u32 = i => (p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)) >>> 0;
    return { batteryMv: p[0] | (p[1] << 8), batteryPct: p[2], charging: !!(p[3] & 1), usbPower: !!(p[3] & 2),
             restarts: u32(4), skipped: u32(8) };
  }

  function decodeData(p) {
    const index = (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0;
    const n = Math.floor((p.length - 6) / 6);
    const samples = [];
    for (let k = 0; k < n; k++) samples.push([int24(p, 6 + 6 * k), int24(p, 9 + 6 * k)]);
    return { index: index, flags: p[4], hr: p[5], samples: samples };
  }

  // ---- session summary
  function segment(name, t0, t1, beats, breaths) {
    const bt = beats.filter(b => b[0] >= t0 && b[0] < t1).map(b => b[0]);
    const rr = [];
    for (let k = 1; k < bt.length; k++) { const g = bt[k] - bt[k - 1]; if (g >= 0.3 && g <= 2.0) rr.push(g); }
    const rates = rr.map((_, i) => {
      const chunk = rr.slice(Math.max(0, i - 4), i + 1);
      return 60 * chunk.length / chunk.reduce((a, v) => a + v, 0);
    });
    const br = breaths.filter(t => t >= t0 && t < t1);
    const gaps = [];
    for (let k = 1; k < br.length; k++) { const g = br[k] - br[k - 1]; if (g >= 1 && g <= 15) gaps.push(g); }
    return {
      name: name, start: t0, duration: t1 - t0, beats: bt.length,
      hrAvg: rr.length ? 60 * rr.length / rr.reduce((a, v) => a + v, 0) : null,
      hrMin: rates.length ? Math.min.apply(null, rates) : null,
      hrMax: rates.length ? Math.max.apply(null, rates) : null,
      breaths: gaps.length ? 60 / median(gaps) : null,
    };
  }

  function summary(start, end, beats, breaths, markers, name) {
    const overall = segment(name || 'Whole session', start, end, beats, breaths);
    const inside = markers.filter(m => m[0] >= start && m[0] < end);
    const poses = [];
    inside.forEach((m, i) => {
      const stop = i + 1 < inside.length ? inside[i + 1][0] : end;
      if (stop - m[0] >= 1) poses.push(segment(m[1], m[0], stop, beats, breaths));
    });
    return { overall: overall, poses: poses };
  }

  // ---- a made-up signal for showing the app without a person
  class DemoSignal {
    constructor(fs) { this.fs = fs; this.n = 0; this.phase = 0; this.seed = 12345; }
    rand() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296 - 0.5; }
    next() {
      const t = this.n / this.fs;
      this.n++;
      const breath = Math.sin(2 * Math.PI * 0.25 * t);
      const rate = 1.2 + 0.08 * breath;  // beats per second, rising on the in-breath
      this.phase = (this.phase + rate / this.fs) % 1;
      const p = this.phase;
      const g = (c, s, a) => a * Math.exp(-((p - c) * (p - c)) / (2 * s * s));
      const mv = g(0.22, 0.030, 0.10) + g(0.355, 0.010, -0.10) + g(0.385, 0.013, 1.0) +
                 g(0.415, 0.011, -0.20) + g(0.65, 0.055, 0.25);
      const ecg = 330 * mv + 60 * Math.sin(2 * Math.PI * 50 * t) + 12 * this.rand() + 40 * breath;
      const resp = 30 * breath + 3 * this.rand();
      return [ecg, resp];
    }
  }

  const api = { Biquad, Chain, BeatDetector, HeartRate, BreathRate, SignalStatus, Pipeline, Parser,
                decodeInfo, decodeData, decodeStatus, summary, DemoSignal, median,
                TYPE_DATA, TYPE_INFO, TYPE_STATUS, FLAG_PLUS_OFF, FLAG_MINUS_OFF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AnahataDSP = api;
})(typeof self !== 'undefined' ? self : this);
