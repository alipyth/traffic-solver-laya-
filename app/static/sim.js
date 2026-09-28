/* Traffic simulation: individual cars, lanes, signals and sensors.
 * Pure logic (no rendering). Runs in the browser at a fixed 60 Hz step so motion is smooth.
 * Coordinates: x = east, z = south (north is -z). 1 unit ≈ 1 m.
 */
(function (global) {
'use strict';

const SP = 80, EDGE = 150, ROAD_W = 10, HALF = ROAD_W / 2, LANE_OFF = 2.5, LEN = EDGE * 2;
const COORDS = [-SP, 0, SP];
const STOP_BACK = HALF + 3.4;          // stop line distance from the intersection centre
const MIN_GREEN = 12, EMERGENCY_MIN_GREEN = 1.5, YELLOW = 2.5, ALL_RED = 1.2;
const IDM = { a: 2.0, b: 3.0, s0: 2.2, T: 1.2 };
const STEP = 1 / 60;
const ROWS = 'ABC';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CAR_COLORS = [0xf25f5c, 0xffe066, 0x4ea8de, 0xf5f3ee, 0x70c1b3, 0xff9f59, 0x9b8cff, 0x3d5a80, 0xe9edf2, 0xd7263d];
const axisOf = d => (d === 'N' || d === 'S') ? 'ns' : 'ew';

class TrafficSim {
  constructor(seed = 7) {
    this.seed = seed;
    this.reset();
  }

  reset() {
    this.t = 0;
    this.gen = (this.gen || 0) + 1;
    this.spawnRng = mulberry32(this.seed);
    this.eventRng = mulberry32(this.seed * 31 + 5);
    this.demand = 1;
    this.rush = false;
    this.nextCarId = 1;
    this.events = [];
    this.history = [];
    this.throughput = 0;
    this.diverted = 0;
    this.exitTimes = [];
    this.recentDelays = [];
    this.ambulanceTrips = [];
    this._histAcc = 0;
    this._buildNetwork();
  }

  _buildNetwork() {
    const lanes = [];
    COORDS.forEach((x0, ci) => {
      lanes.push({ axis: 'z', sign: +1, fixed: x0 - LANE_OFF, approach: 'N', line: ci });
      lanes.push({ axis: 'z', sign: -1, fixed: x0 + LANE_OFF, approach: 'S', line: ci });
    });
    COORDS.forEach((z0, ri) => {
      lanes.push({ axis: 'x', sign: +1, fixed: z0 + LANE_OFF, approach: 'W', line: ri });
      lanes.push({ axis: 'x', sign: -1, fixed: z0 - LANE_OFF, approach: 'E', line: ri });
    });
    this.intersections = [];
    this.byId = {};
    COORDS.forEach((z, ri) => COORDS.forEach((x, ci) => {
      const it = {
        id: ROWS[ri] + (ci + 1), row: ri, col: ci, x, z, approaches: {},
        signal: { axis: (ri + ci) % 2 ? 'ew' : 'ns', state: 'green', t: 3 + ri * 2 + ci, desired: null, urgent: false },
      };
      this.intersections.push(it);
      this.byId[it.id] = it;
    }));
    // Every lane is a straight line across the map; heavier corridors get a higher weight.
    const w = mulberry32(this.seed * 7 + 1);
    lanes.forEach((ln, idx) => {
      ln.idx = idx;
      ln.cars = [];
      ln.pending = [];
      ln.weight = 0.65 + w() * 0.7 + (ln.axis === 'z' && ln.line === 1 ? 0.45 : 0);
      ln.nextSpawn = w() * 3;
      ln.dir = ln.axis === 'z' ? { x: 0, z: ln.sign } : { x: ln.sign, z: 0 };
      ln.heading = Math.atan2(ln.dir.x, ln.dir.z);
      ln.stops = COORDS.map((c, k) => {
        const it = ln.axis === 'z' ? this.byId[ROWS[k] + (ln.line + 1)] : this.byId[ROWS[ln.line] + (k + 1)];
        const sc = ln.sign > 0 ? c + EDGE : EDGE - c;
        return { it, sc, stop: sc - STOP_BACK, box0: sc - HALF, box1: sc + HALF };
      }).sort((a, b) => a.sc - b.sc);
      ln.stops.forEach((st, k) => {
        st.k = k;
        st.segStart = k > 0 ? ln.stops[k - 1].box1 : 0;
        st.exitEnd = k < 2 ? ln.stops[k + 1].stop : LEN;
        st.it.approaches[ln.approach] = { lane: ln, stop: st };
      });
    });
    this.lanes = lanes;
  }

  pos(lane, s) {
    const along = lane.sign > 0 ? -EDGE + s : EDGE - s;
    return lane.axis === 'z' ? { x: lane.fixed, z: along } : { x: along, z: lane.fixed };
  }

  clock() {
    const s = Math.floor(7.5 * 3600 + this.t);
    const h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  log(type, text) {
    this.events.unshift({ t: this.clock(), type, text });
    if (this.events.length > 60) this.events.pop();
  }

  // ---------------------------------------------------------------- signals
  light(it, approach) {
    const s = it.signal;
    if (axisOf(approach) !== s.axis) return 'red';
    return s.state === 'green' ? 'green' : s.state === 'yellow' ? 'yellow' : 'red';
  }

  setDesired(id, axis, urgent = false) {
    const s = this.byId[id].signal;
    s.desired = axis;
    s.urgent = urgent;
  }

  _stepSignal(it, dt) {
    const s = it.signal;
    s.t += dt;
    if (s.state === 'green') {
      const minG = s.urgent ? EMERGENCY_MIN_GREEN : MIN_GREEN;
      if (s.desired && s.desired !== s.axis && s.t >= minG) { s.state = 'yellow'; s.t = 0; }
    } else if (s.state === 'yellow' && s.t >= YELLOW) {
      s.state = 'allred'; s.t = 0;
    } else if (s.state === 'allred' && s.t >= ALL_RED) {
      s.state = 'green'; s.axis = s.axis === 'ns' ? 'ew' : 'ns'; s.t = 0;
    }
  }

  // ---------------------------------------------------------------- vehicles
  _makeSpec(type) {
    const r = this.spawnRng;
    const roll = r(), color = CAR_COLORS[Math.floor(r() * CAR_COLORS.length)], vj = r();
    type = type || (roll < 0.07 ? 'bus' : roll < 0.14 ? 'van' : 'car');
    const base = { car: [4.3, 11.5], van: [5.4, 10.5], bus: [9.5, 9.5], ambulance: [5.6, 15.5] }[type];
    return { type, len: base[0], vmax: base[1] * (0.9 + vj * 0.2), color: type === 'ambulance' ? 0xffffff : type === 'bus' ? 0xf3b33d : color };
  }

  _idm(c, gap, dv) {
    const { a, b, s0, T } = IDM;
    const sStar = s0 + Math.max(0, c.v * T + (c.v * dv) / (2 * Math.sqrt(a * b)));
    return a * (1 - Math.pow(c.v / c.vmax, 4) - Math.pow(sStar / Math.max(gap, 0.05), 2));
  }

  _mustStop(c, lane, i, st, dist) {
    const light = this.light(st.it, lane.approach);
    if (light === 'red') return true;
    if (light === 'yellow') return (c.v * c.v) / (2 * 4.5) < dist + 0.5;
    // Green: don't enter the box unless there is room to leave it (keep-clear rule).
    const L = lane.cars[i - 1];
    if (L && dist < 30) {
      const rear = L.s - L.len / 2;
      if (rear > st.stop && rear < st.box1 + c.len + 2.2 && L.v < 2.5) return true;
    }
    return false;
  }

  _stepLane(lane, dt) {
    const cars = lane.cars;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.fixed) { c.acc = 0; continue; }
      const front = c.s + c.len / 2;
      let acc = this._idm(c, 1e4, 0);
      if (i > 0) {
        const L = cars[i - 1];
        acc = Math.min(acc, this._idm(c, L.s - L.len / 2 - front, c.v - L.v));
      }
      while (c.stopIdx < 3 && lane.stops[c.stopIdx].stop < front - 0.6) { c.stopIdx++; c.wait = 0; }
      if (c.stopIdx < 3) {
        const st = lane.stops[c.stopIdx], dist = st.stop - front;
        if (dist < 70 && this._mustStop(c, lane, i, st, dist)) acc = Math.min(acc, this._idm(c, Math.max(dist, 0.05), c.v));
      }
      c.acc = Math.max(-9, acc);
    }
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.fixed) continue;
      const v1 = Math.max(0, c.v + c.acc * dt);
      c.s += (c.v + v1) * 0.5 * dt;
      c.v = v1;
      if (i > 0) {
        const L = cars[i - 1], maxS = L.s - (L.len + c.len) / 2 - 0.4;
        if (c.s > maxS) { c.s = maxS; c.v = Math.min(c.v, L.v); }
      }
      if (c.v < 1) { c.wait += dt; c.stopped += dt; }
      c.brake = c.acc < -0.6 || c.v < 0.3;
    }
    // exits
    while (cars.length && cars[0].s - cars[0].len / 2 > LEN) {
      const c = cars.shift();
      if (c.fixed) continue;
      this.throughput++;
      this.exitTimes.push(this.t);
      this.recentDelays.push(c.stopped);
      if (this.recentDelays.length > 80) this.recentDelays.shift();
      if (c.type === 'ambulance') {
        const trip = this.t - c.born;
        this.ambulanceTrips.push({ trip, stopped: c.stopped });
        this.log('saved', `آمبولانس از شهر خارج شد: سفر ${trip.toFixed(0)}s، توقف ${c.stopped.toFixed(1)}s`);
      }
    }
  }

  _spawn(lane) {
    const hourWave = 1 + 0.25 * Math.sin(this.t / 90);
    const rush = this.rush ? (lane.axis === 'z' ? 1.6 : 1.1) : 1;
    const rate = 0.085 * lane.weight * this.demand * rush * hourWave;
    while (this.t >= lane.nextSpawn) {
      const spec = this._makeSpec();
      // A driver who sees the entrance jammed takes another route instead of waiting forever.
      if (lane.pending.length < 4) lane.pending.push(spec); else this.diverted++;
      lane.nextSpawn += -Math.log(1 - this.spawnRng() * 0.999) / rate;
    }
    if (!lane.pending.length) return;
    const last = lane.cars[lane.cars.length - 1];
    const spec = lane.pending[0];
    const room = last ? last.s - last.len / 2 : 1e9;
    if (room < spec.len + 2.5) return;
    lane.pending.shift();
    lane.cars.push({
      id: this.nextCarId++, ...spec, s: spec.len / 2,
      v: last ? Math.min(spec.vmax * 0.8, last.v + 2) : spec.vmax * 0.8,
      acc: 0, wait: 0, stopped: 0, stopIdx: 0, born: this.t, brake: false,
    });
  }

  advance(realDt) {
    let left = Math.min(realDt, 1.0);
    while (left > 1e-6) {
      const dt = Math.min(STEP, left);
      left -= dt;
      this.t += dt;
      for (const it of this.intersections) this._stepSignal(it, dt);
      for (const ln of this.lanes) { this._spawn(ln); this._stepLane(ln, dt); }
      this._expireWrecks();
      this._histAcc += dt;
      if (this._histAcc >= 2) { this._histAcc = 0; this._record(); }
    }
  }

  // ---------------------------------------------------------------- scenarios
  scenario(kind) {
    const r = this.eventRng;
    if (kind === 'rush') { this.rush = true; this.log('rush', 'ساعت شلوغی: ورود خودرو به خیابان‌های شمال–جنوب ×۱٫۶'); }
    else if (kind === 'normal') {
      this.demand = 1;
      this.rush = false;
      for (const ln of this.lanes) ln.cars = ln.cars.filter(c => !c.fixed);
      this.log('normal', 'ترافیک عادی شد و موانع برداشته شدند.');
    } else if (kind === 'stress') {
      for (const ln of this.lanes) for (let k = 0; k < 3; k++) ln.pending.push(this._makeSpec());
      this.log('stress', 'موج ناگهانی: ۳۶ خودرو هم‌زمان وارد شهر شدند.');
    } else if (kind === 'ambulance') {
      const ln = this.lanes[Math.floor(r() * this.lanes.length)];
      ln.pending.unshift(this._makeSpec('ambulance'));
      this.log('ambulance', `آمبولانس از ورودی ${dirFa(ln.approach)} محور ${ln.line + 1} وارد شد.`);
    } else if (kind === 'accident') {
      const ln = this.lanes[Math.floor(r() * this.lanes.length)];
      const st = ln.stops[1 + Math.floor(r() * 2)];
      const s = st.segStart + (st.stop - st.segStart) * 0.55;
      ln.cars = ln.cars.filter(c => Math.abs(c.s - s) > 5);
      let idx = ln.cars.findIndex(c => c.s < s);
      if (idx < 0) idx = ln.cars.length;
      ln.cars.splice(idx, 0, { id: this.nextCarId++, type: 'wreck', fixed: true, len: 4.6, s, v: 0, vmax: 1, acc: 0,
        color: 0x8a8f96, wait: 0, stopped: 0, stopIdx: 0, until: this.t + 40, brake: true });
      this.log('accident', `تصادف روی ورودی ${dirFa(ln.approach)} چهارراه ${st.it.id}؛ این مسیر ۴۰ ثانیه بسته است.`);
    }
  }

  _expireWrecks() {
    for (const ln of this.lanes) {
      if (ln.cars.some(c => c.fixed && c.until <= this.t)) {
        ln.cars = ln.cars.filter(c => !(c.fixed && c.until <= this.t));
        this.log('normal', 'مسیر تصادف باز شد.');
      }
    }
  }

  // ---------------------------------------------------------------- sensors
  /** What the road sensors report for one intersection (sent to the brain). */
  sensors(it) {
    const out = { id: it.id, queues: {}, approaching: {}, wait: {}, downstream: {}, emergency_dir: null,
      blocked_dir: null, green_axis: it.signal.axis };
    for (const d of ['N', 'S', 'E', 'W']) {
      const { lane, stop: st } = it.approaches[d];
      let q = 0, ap = 0, w = 0, occ = 0;
      for (const c of lane.cars) {
        const front = c.s + c.len / 2;
        if (front > st.segStart && front <= st.stop + 0.6) {
          if (c.fixed) { out.blocked_dir = d; continue; }
          if (c.v < 2) q++; else ap++;
          w = Math.max(w, c.wait);
          if (c.type === 'ambulance') out.emergency_dir = d;
        }
        if (c.s > st.box1 && c.s < st.exitEnd) occ += c.len + IDM.s0;
      }
      out.queues[d] = q;
      out.approaching[d] = ap;
      out.wait[d] = +w.toFixed(1);
      out.downstream[d] = +Math.min(1, occ / (st.exitEnd - st.box1)).toFixed(2);
    }
    return out;
  }

  allSensors() { return this.intersections.map(it => this.sensors(it)); }

  // ---------------------------------------------------------------- metrics
  metrics() {
    let cars = 0, queued = 0, vs = 0, waits = 0, nw = 0;
    for (const ln of this.lanes) for (const c of ln.cars) {
      if (c.fixed) continue;
      cars++; vs += c.v;
      if (c.v < 2) { queued++; waits += c.wait; nw++; }
    }
    const pending = this.lanes.reduce((a, l) => a + l.pending.length, 0);
    while (this.exitTimes.length && this.exitTimes[0] < this.t - 60) this.exitTimes.shift();
    const d = this.recentDelays;
    const amb = this.ambulanceTrips[this.ambulanceTrips.length - 1];
    return {
      cars, queued, pending,
      avgWait: nw ? waits / nw : 0,
      avgDelay: d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0,
      throughput: this.throughput,
      perMin: this.exitTimes.length * (this.t < 60 ? 60 / Math.max(this.t, 1) : 1),
      speedKmh: cars ? (vs / cars) * 3.6 : 0,
      ambulanceStopped: amb ? amb.stopped : null,
    };
  }

  _record() {
    const m = this.metrics();
    this.history.push({ t: this.t, delay: m.avgDelay, queued: m.queued, speed: m.speedKmh, perMin: m.perMin });
    if (this.history.length > 300) this.history.shift();
  }
}

function dirFa(d) { return { N: 'شمالی', S: 'جنوبی', E: 'شرقی', W: 'غربی' }[d]; }

global.TrafficSim = TrafficSim;
global.SIMCONST = { SP, EDGE, ROAD_W, HALF, LANE_OFF, LEN, COORDS, STOP_BACK, MIN_GREEN, YELLOW, ALL_RED, axisOf, dirFa };
})(window);
