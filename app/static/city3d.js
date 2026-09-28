/* Isometric low-poly city renderer for TrafficSim (Three.js r160, global THREE). */
(function (global) {
'use strict';
const T = global.THREE;
const C = global.SIMCONST;
const { EDGE, HALF, COORDS, STOP_BACK, ROAD_W } = C;
const MAXCARS = 700;
const SIG = { red: [0x4a1515, 0xff4d4d], yellow: [0x4a3b12, 0xffc83d], green: [0x143a24, 0x3dff8e] }; // [off, on]

const PAL = {
  bg: 0x0d1417, soil: 0x4a3a2c, grass: 0x9ccf84, grassDark: 0x86bf70, walk: 0xe4ddd0, road: 0x3a414c,
  box: 0x424955, line: 0xf4f0e6, yellow: 0xf7c948, water: 0x6ec6de,
  buildings: [0xf6d3b3, 0xf2b48c, 0xbfd7ea, 0xa8d5c2, 0xf8e8b0, 0xd9c6ec, 0xf4f1ea, 0xe7a9a2, 0xc9dcb3],
  roofs: [0x8c6e5d, 0x6d7f8f, 0x7b8e76, 0xa07a6a, 0x5f6b7a],
};

function lambert(color, opts = {}) { return new T.MeshLambertMaterial({ color, ...opts }); }

/** Collects static meshes and merges them into one draw call per material (hundreds -> ~20 draws). */
class StaticBatch {
  constructor() { this.groups = new Map(); this._m = new T.Matrix4(); this._q = new T.Quaternion(); this._s = new T.Vector3(1, 1, 1); }
  add(geo, mat, x, y, z, rotY = 0, cast = true) {
    const key = mat.uuid + (cast ? 'c' : '');
    if (!this.groups.has(key)) this.groups.set(key, { mat, cast, geos: [] });
    this._q.setFromAxisAngle(new T.Vector3(0, 1, 0), rotY);
    this._m.compose(new T.Vector3(x, y, z), this._q, this._s);
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(this._m);
    this.groups.get(key).geos.push(g);
  }
  flush(scene) {
    for (const { mat, cast, geos } of this.groups.values()) {
      const merged = new T.BufferGeometry();
      for (const name of ['position', 'normal', 'uv']) {
        const size = geos[0].attributes[name].itemSize;
        const arr = new Float32Array(geos.reduce((a, g) => a + g.attributes[name].array.length, 0));
        let off = 0;
        for (const g of geos) { arr.set(g.attributes[name].array, off); off += g.attributes[name].array.length; }
        merged.setAttribute(name, new T.BufferAttribute(arr, size));
      }
      merged.computeBoundingSphere();
      const mesh = new T.Mesh(merged, mat);
      mesh.castShadow = cast; mesh.receiveShadow = true;
      scene.add(mesh);
      geos.forEach(g => g.dispose());
    }
    this.groups.clear();
  }
}

function windowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#6f8aa3'; g.fillRect(12, 16, 40, 30);
  g.fillStyle = '#9fb7cc'; g.fillRect(12, 16, 40, 8);
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.colorSpace = T.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

class CityView {
  constructor(el, sim, { interactive = true, labels = false, onSelect = null, pixelRatio = 1.5 } = {}) {
    this.el = el; this.sim = sim; this.onSelect = onSelect; this.showLabels = labels;
    this.selectedId = 'B2'; this.pulses = []; this.visible = true;
    this.scene = new T.Scene();
    this.scene.background = new T.Color(PAL.bg);
    this.camera = new T.OrthographicCamera(-1, 1, 1, -1, 1, 1200);
    this.target = new T.Vector3(0, 0, 0);
    this.baseView = 270; this.camera.zoom = 1;
    this.renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, pixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // the city is static: draw its shadows once
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    el.appendChild(this.renderer.domElement);

    this.scene.add(new T.HemisphereLight(0xffffff, 0x6b7f6a, 1.35));
    const sun = new T.DirectionalLight(0xfff1dc, 2.3);
    sun.position.set(-120, 220, 90);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -200, right: 200, top: 200, bottom: -200, near: 10, far: 600 });
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.6;
    this.scene.add(sun);

    this.batch = new StaticBatch();
    this._buildGround();
    this._buildRoads();
    this._buildBlocks();
    this._buildSignals();
    this.batch.flush(this.scene);
    this.renderer.shadowMap.needsUpdate = true;
    this._buildCars();
    this._buildOverlays();
    if (labels) this._buildLabels();
    if (interactive) this._bindControls();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(el);
  }

  setSim(sim) { this.sim = sim; }

  // ------------------------------------------------------------------ static city
  _buildGround() {
    const W = EDGE * 2 + 16;
    const base = new T.Mesh(new T.BoxGeometry(W, 8, W), [
      lambert(PAL.soil), lambert(PAL.soil), lambert(PAL.grass), lambert(PAL.soil), lambert(PAL.soil), lambert(PAL.soil)]);
    base.position.y = -4.05;
    base.receiveShadow = true;
    this.scene.add(base);
  }

  _buildRoads() {
    const roadMat = lambert(PAL.road), boxMat = lambert(PAL.box);
    const L = EDGE * 2 + 16;
    COORDS.forEach(c => {
      this.batch.add(new T.PlaneGeometry(ROAD_W, L).rotateX(-Math.PI / 2), roadMat, c, 0.02, 0, 0, false);
      this.batch.add(new T.PlaneGeometry(L, ROAD_W).rotateX(-Math.PI / 2), roadMat, 0, 0.021, c, 0, false);
    });
    COORDS.forEach(z => COORDS.forEach(x => {
      this.batch.add(new T.PlaneGeometry(ROAD_W, ROAD_W).rotateX(-Math.PI / 2), boxMat, x, 0.03, z, 0, false);
    }));
    // markings: centre dashes, crosswalk stripes, stop lines (all instanced)
    const marks = [];
    const nearX = v => COORDS.some(c => Math.abs(v - c) < HALF + 5);
    for (const c of COORDS) {
      for (let t = -EDGE - 6; t <= EDGE + 6; t += 6) {
        if (nearX(t)) continue;
        marks.push([c, t, 0.22, 3, PAL.line]);
        marks.push([t, c, 3, 0.22, PAL.line]);
      }
    }
    for (const z of COORDS) for (const x of COORDS) {
      for (const [dx, dz] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
        const cw = HALF + 1.3;
        for (let k = -4; k <= 4; k++) {
          const off = k * 1.1;
          if (dx === 0) marks.push([x + off, z + dz * cw, 0.55, 2.2, PAL.line]);
          else marks.push([x + dx * cw, z + off, 2.2, 0.55, PAL.line]);
        }
      }
    }
    const g = new T.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
    const im = new T.InstancedMesh(g, new T.MeshBasicMaterial({ color: 0xffffff }), marks.length);
    const m = new T.Matrix4(), col = new T.Color();
    marks.forEach(([x, z, w, d, c], i) => {
      m.makeScale(w, 1, d); m.setPosition(x, 0.045, z);
      im.setMatrixAt(i, m); im.setColorAt(i, col.set(c));
    });
    this.scene.add(im);
  }

  _buildBlocks() {
    const r = mulberry(99);
    const edges = [-EDGE - 8, ...COORDS.flatMap(c => [c - HALF, c + HALF]), EDGE + 8];
    const spans = [];
    for (let k = 0; k < edges.length; k += 2) spans.push([edges[k], edges[k + 1]]);
    const winTex = windowTexture();
    const wallMats = PAL.buildings.map(c => new T.MeshLambertMaterial({ color: c, map: winTex }));
    const roofMats = PAL.roofs.map(c => lambert(c));
    const acMat = lambert(0xd8dde2);
    const walkMat = lambert(PAL.walk), grassMat = lambert(PAL.grassDark), waterMat = new T.MeshLambertMaterial({ color: PAL.water });
    const trees = [];
    spans.forEach(([x0, x1], bi) => spans.forEach(([z0, z1], bj) => {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0 - 1.2, d = z1 - z0 - 1.2;
      this.batch.add(new T.BoxGeometry(w, 0.5, d), walkMat, cx, 0.25, cz, 0, false);
      // street trees along the sidewalk
      for (let t = -w / 2 + 5; t < w / 2 - 4; t += 11) { trees.push([cx + t, cz - d / 2 + 2.2]); trees.push([cx + t, cz + d / 2 - 2.2]); }
      const park = (bi === 1 && bj === 2) || (bi === 2 && bj === 1);
      const iw = w - 14, id = d - 14;
      if (park) {
        this.batch.add(new T.BoxGeometry(iw, 0.3, id), grassMat, cx, 0.6, cz, 0, false);
        const pr = Math.min(iw, id) * 0.22;
        const pond = { position: { x: cx + iw * 0.12, z: cz - id * 0.1 } };
        this.batch.add(new T.CylinderGeometry(pr, pr, 0.3, 28), waterMat, pond.position.x, 0.7, pond.position.z, 0, false);
        for (let k = 0; k < 26; k++) {
          const tx = cx + (r() - 0.5) * iw * 0.9, tz = cz + (r() - 0.5) * id * 0.9;
          if (Math.hypot(tx - pond.position.x, tz - pond.position.z) > Math.min(iw, id) * 0.28) trees.push([tx, tz, 1.3]);
        }
        return;
      }
      const nx = Math.max(2, Math.round(iw / 20)), nz = Math.max(2, Math.round(id / 20));
      const lw = iw / nx, ld = id / nz;
      const centreDist = Math.hypot(cx, cz);
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const inner = i > 0 && i < nx - 1 && j > 0 && j < nz - 1;
        if (inner && r() < 0.6) continue; // courtyard
        if (r() < 0.22) { trees.push([cx - iw / 2 + lw * (i + .5), cz - id / 2 + ld * (j + .5), 1.2]); continue; }
        const bw = lw * (0.7 + r() * 0.22), bd = ld * (0.7 + r() * 0.22);
        const h = 4 + r() * 7 + Math.max(0, 1 - centreDist / 170) * (4 + r() * 14);
        const bx = cx - iw / 2 + lw * (i + 0.5), bz = cz - id / 2 + ld * (j + 0.5);
        const geo = new T.BoxGeometry(bw, h, bd);
        scaleUV(geo, bw, h, bd);
        const wall = wallMats[Math.floor(r() * wallMats.length)];
        const roof = roofMats[Math.floor(r() * roofMats.length)];
        this.batch.add(geo, wall, bx, 0.5 + h / 2, bz);             // the roof slab below covers the top face
        this.batch.add(new T.BoxGeometry(bw + 0.6, 0.7, bd + 0.6), roof, bx, 0.5 + h + 0.35, bz);
        if (r() < 0.5) this.batch.add(new T.BoxGeometry(bw * 0.3, 1.6, bd * 0.3), acMat, bx + bw * 0.15, 0.5 + h + 1.4, bz - bd * 0.12);
      }
    }));
    // instanced trees
    const trunk = new T.InstancedMesh(new T.CylinderGeometry(0.35, 0.45, 2.4, 6), lambert(0x7a5a43), trees.length);
    const crown = new T.InstancedMesh(new T.IcosahedronGeometry(2.1, 0), new T.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), trees.length);
    trunk.castShadow = crown.castShadow = true;
    const m = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3(), col = new T.Color();
    const greens = [0x5fae5b, 0x4c9a55, 0x77bf5e, 0x3f8a57, 0x8cc665];
    trees.forEach(([x, z, k = 1], i) => {
      const sc = k * (0.8 + r() * 0.45);
      m.compose(p.set(x, 0.5 + 1.2 * sc, z), q.identity(), s.set(sc, sc, sc)); trunk.setMatrixAt(i, m);
      q.setFromAxisAngle(new T.Vector3(0, 1, 0), r() * 6);
      m.compose(p.set(x, 0.5 + 3.4 * sc, z), q, s.set(sc, sc * (1 + r() * 0.3), sc)); crown.setMatrixAt(i, m);
      crown.setColorAt(i, col.set(greens[Math.floor(r() * greens.length)]));
    });
    this.scene.add(trunk, crown);
  }

  _buildSignals() {
    const poleMat = lambert(0x2c323a), headMat = lambert(0x1b1f25);
    const poleGeo = new T.CylinderGeometry(0.22, 0.28, 6, 6), headGeo = new T.BoxGeometry(1.1, 3.1, 0.8);
    const n = this.sim.intersections.length * 4;
    const inst = (geo, mat, count) => { const m = new T.InstancedMesh(geo, mat, count); m.setColorAt(0, new T.Color()); this.scene.add(m); return m; };
    this.lamps = inst(new T.SphereGeometry(0.4, 10, 8), new T.MeshBasicMaterial({ color: 0xffffff }), n * 3);
    this.bars = inst(new T.PlaneGeometry(4.6, 1.1).rotateX(-Math.PI / 2), new T.MeshBasicMaterial({ color: 0xffffff }), n);
    // a coloured wash on the last 12 m of each approach lane: the light is readable from far away
    this.washes = inst(new T.PlaneGeometry(4.6, 12).rotateX(-Math.PI / 2),
      new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false }), n);
    this.washes.renderOrder = 1;
    this.signalParts = [];
    const m = new T.Matrix4(), q = new T.Quaternion(), one = new T.Vector3(1, 1, 1), up = new T.Vector3(0, 1, 0);
    let k = 0;
    for (const it of this.sim.intersections) {
      for (const d of ['N', 'S', 'E', 'W']) {
        const dir = { N: [0, 1], S: [0, -1], W: [1, 0], E: [-1, 0] }[d];   // travel direction on this approach
        const right = [-dir[1], dir[0]];
        const px = it.x - dir[0] * (HALF + 1.4) + right[0] * (HALF + 1.4);
        const pz = it.z - dir[1] * (HALF + 1.4) + right[1] * (HALF + 1.4);
        const face = Math.atan2(-dir[0], -dir[1]);
        this.batch.add(poleGeo, poleMat, px, 3.5, pz, face);
        this.batch.add(headGeo, headMat, px, 6.8, pz, face);
        q.setFromAxisAngle(up, face);
        const fwd = [Math.sin(face) * 0.45, Math.cos(face) * 0.45];
        [7.8, 6.8, 5.8].forEach((y, j) => { m.compose(new T.Vector3(px + fwd[0], y, pz + fwd[1]), q, one); this.lamps.setMatrixAt(k * 3 + j, m); });
        const lane = [it.x + right[0] * 2.5, it.z + right[1] * 2.5];
        q.setFromAxisAngle(up, dir[0] !== 0 ? Math.PI / 2 : 0);
        const sb = STOP_BACK - 0.35, wb = STOP_BACK + 6;
        m.compose(new T.Vector3(lane[0] - dir[0] * sb, 0.06, lane[1] - dir[1] * sb), q, one); this.bars.setMatrixAt(k, m);
        m.compose(new T.Vector3(lane[0] - dir[0] * wb, 0.05, lane[1] - dir[1] * wb), q, one); this.washes.setMatrixAt(k, m);
        this.signalParts.push({ it, d, k, state: null });
        k++;
      }
    }
  }

  _buildCars() {
    const mk = (geo, mat) => {
      const m = new T.InstancedMesh(geo, mat, MAXCARS);
      m.instanceMatrix.setUsage(T.DynamicDrawUsage);
      m.castShadow = false; m.frustumCulled = false; m.count = 0;
      return m;
    };
    const body = new T.BoxGeometry(1, 1, 1); body.translate(0, 0.5, 0);
    const white = () => new T.MeshLambertMaterial({ color: 0xffffff });
    this.carBody = mk(body, white());
    this.carCabin = mk(body.clone(), white());
    this.carWheels = mk(body.clone(), lambert(0x16191d));
    this.carTail = mk(body.clone(), new T.MeshBasicMaterial({ color: 0xffffff }));
    this.carTail.castShadow = false;
    for (const m of [this.carBody, this.carCabin, this.carTail]) m.setColorAt(0, new T.Color(1, 1, 1));
    this.scene.add(this.carBody, this.carCabin, this.carWheels, this.carTail);
    this.beacons = [];
    for (let k = 0; k < 6; k++) {
      const b = new T.Mesh(new T.BoxGeometry(1.4, 0.45, 0.5), new T.MeshBasicMaterial({ color: 0xff2d2d }));
      b.visible = false; this.scene.add(b); this.beacons.push(b);
    }
    // a big floating marker above every ambulance so it can be followed from far away
    this.pins = [];
    for (let k = 0; k < 6; k++) {
      const pin = new T.Mesh(new T.ConeGeometry(2.6, 6, 16).rotateX(Math.PI), new T.MeshBasicMaterial({ color: 0xff3b3b }));
      pin.visible = false; this.scene.add(pin); this.pins.push(pin);
    }
    this.hazards = [];
    for (let k = 0; k < 4; k++) {
      const h = new T.Mesh(new T.ConeGeometry(1.1, 2.4, 4), new T.MeshBasicMaterial({ color: 0xff8a1f }));
      h.visible = false; this.scene.add(h); this.hazards.push(h);
    }
    this._m = new T.Matrix4(); this._q = new T.Quaternion(); this._s = new T.Vector3(); this._p = new T.Vector3();
    this._col = new T.Color(); this._up = new T.Vector3(0, 1, 0);
  }

  _buildOverlays() {
    const ringGeo = new T.RingGeometry(9.2, 10.2, 48); ringGeo.rotateX(-Math.PI / 2);
    this.selRing = new T.Mesh(ringGeo, new T.MeshBasicMaterial({ color: 0x7ef9ff, transparent: true, opacity: 0.9, depthWrite: false }));
    this.selRing.renderOrder = 3; this.scene.add(this.selRing);
    this.pulseGeo = new T.RingGeometry(7.5, 8.5, 48); this.pulseGeo.rotateX(-Math.PI / 2);
    // invisible pick targets
    this.pickables = this.sim.intersections.map(it => {
      const m = new T.Mesh(new T.BoxGeometry(ROAD_W + 6, 2, ROAD_W + 6), new T.MeshBasicMaterial({ visible: false }));
      m.position.set(it.x, 1, it.z); m.userData.id = it.id; this.scene.add(m); return m;
    });
  }

  _buildLabels() {
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'label-layer';
    this.el.appendChild(this.labelLayer);
    this.labels = {};
    for (const it of this.sim.intersections) {
      const d = document.createElement('button');
      d.className = 'ix-label';
      d.innerHTML = `<b>${it.id}</b><i class="plus"><i class="v"></i><i class="h"></i></i><span></span>`;
      d.title = 'چهارراه ' + it.id;
      d.onclick = () => this.onSelect && this.onSelect(it.id);
      this.labelLayer.appendChild(d);
      this.labels[it.id] = d;
    }
  }

  // ------------------------------------------------------------------ interaction
  _bindControls() {
    const el = this.renderer.domElement;
    let drag = null, moved = 0;
    el.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; moved = 0; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      moved += Math.abs(dx) + Math.abs(dy);
      drag = { x: e.clientX, y: e.clientY };
      const k = (this.camera.top - this.camera.bottom) / this.camera.zoom / el.clientHeight;
      this.target.x -= dx * k;
      this.target.z -= dy * k * 1.15;
      this.target.x = clamp(this.target.x, -EDGE, EDGE); this.target.z = clamp(this.target.z, -EDGE, EDGE);
      this._placeCamera();
    });
    el.addEventListener('pointerup', e => {
      if (drag && moved < 6) this._pick(e);
      drag = null;
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      this.camera.zoom = clamp(this.camera.zoom * (e.deltaY > 0 ? 0.9 : 1.1), 0.7, 4);
      this.camera.updateProjectionMatrix();
    }, { passive: false });
    el.addEventListener('dblclick', () => this.resetCamera());
  }

  _pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new T.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new T.Raycaster(); rc.setFromCamera(v, this.camera);
    const hit = rc.intersectObjects(this.pickables)[0];
    if (hit && this.onSelect) this.onSelect(hit.object.userData.id);
  }

  resetCamera() { this.target.set(0, 0, 0); this.camera.zoom = 1; this.camera.updateProjectionMatrix(); this._placeCamera(); }

  focus(id, zoom) {
    const it = this.sim.byId[id];
    this.target.set(it.x, 0, it.z);
    if (zoom) { this.camera.zoom = zoom; this.camera.updateProjectionMatrix(); }
    this._placeCamera();
  }

  _placeCamera() {
    this.camera.position.set(this.target.x, 380, this.target.z + 210);
    this.camera.lookAt(this.target);
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    const aspect = w / h, v = aspect < 1 ? this.baseView / aspect * 0.8 : this.baseView;
    Object.assign(this.camera, { left: -v * aspect / 2, right: v * aspect / 2, top: v / 2, bottom: -v / 2 });
    this.camera.updateProjectionMatrix();
    this._placeCamera();
  }

  pulse(id, color = 0x7ef9ff) {
    const it = this.sim.byId[id];
    const m = new T.Mesh(this.pulseGeo, new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
    m.position.set(it.x, 0.2, it.z); m.renderOrder = 4; this.scene.add(m);
    this.pulses.push({ m, age: 0 });
  }

  // ------------------------------------------------------------------ per-frame
  update(dt, labelInfo) {
    const sim = this.sim, now = performance.now() / 1000;
    // signals
    let sigDirty = false;
    for (const p of this.signalParts) {
      const st = sim.light(p.it, p.d);
      if (st !== p.state) {
        p.state = st;
        ['red', 'yellow', 'green'].forEach((c, j) => this.lamps.setColorAt(p.k * 3 + j, this._col.setHex(SIG[c][c === st ? 1 : 0])));
        this.bars.setColorAt(p.k, this._col.setHex(SIG[st][1]));
        this.washes.setColorAt(p.k, this._col.setHex(SIG[st][1]));
        sigDirty = true;
      }
    }
    if (sigDirty) for (const im of [this.lamps, this.bars, this.washes]) im.instanceColor.needsUpdate = true;
    // cars
    let n = 0, nb = 0, nh = 0;
    const m = this._m, q = this._q, s = this._s, p = this._p, col = this._col;
    for (const ln of sim.lanes) {
      q.setFromAxisAngle(this._up, ln.heading);
      for (const c of ln.cars) {
        if (n >= MAXCARS) break;
        const pos = sim.pos(ln, c.s);
        const w = c.type === 'bus' ? 2.5 : 2.05, L = c.len - 0.3;
        const bodyH = c.type === 'bus' ? 2.6 : c.type === 'van' || c.type === 'ambulance' ? 1.8 : 1.0;
        let qq = q;
        if (c.fixed) { qq = q.clone().multiply(new T.Quaternion().setFromAxisAngle(this._up, 0.5)); }
        m.compose(p.set(pos.x, 0.62, pos.z), qq, s.set(w, bodyH, L)); this.carBody.setMatrixAt(n, m);
        this.carBody.setColorAt(n, col.setHex(c.color));
        const cabH = c.type === 'bus' ? 0.2 : 0.75;
        const cabL = c.type === 'car' ? L * 0.5 : L * 0.35;
        const cabZ = c.type === 'car' ? -L * 0.06 : L * 0.3;
        p.set(pos.x + ln.dir.x * cabZ, 0.62 + bodyH, pos.z + ln.dir.z * cabZ);
        m.compose(p, qq, s.set(w * 0.86, cabH, cabL)); this.carCabin.setMatrixAt(n, m);
        this.carCabin.setColorAt(n, col.setHex(c.type === 'ambulance' ? 0xffffff : c.type === 'bus' ? 0x2c3e50 : 0x243140));
        m.compose(p.set(pos.x, 0.12, pos.z), qq, s.set(w * 1.04, 0.62, L * 0.78)); this.carWheels.setMatrixAt(n, m);
        const back = -L / 2 - 0.02;
        m.compose(p.set(pos.x + ln.dir.x * back, 0.9, pos.z + ln.dir.z * back), qq, s.set(w * 0.8, 0.3, 0.12));
        this.carTail.setMatrixAt(n, m);
        this.carTail.setColorAt(n, col.setHex(c.brake ? 0xff2a2a : 0x5a1a1a));
        if (c.type === 'ambulance' && nb < this.beacons.length) {
          const b = this.beacons[nb++]; b.visible = true;
          b.position.set(pos.x, 0.62 + bodyH + 0.3, pos.z); b.quaternion.copy(q);
          b.material.color.setHex(Math.floor(now * 6) % 2 ? 0xff2d2d : 0x2d6bff);
          const pin = this.pins[nb - 1]; pin.visible = true;
          pin.position.set(pos.x, 14 + Math.sin(now * 5) * 1.2, pos.z);
        }
        if (c.fixed && nh < this.hazards.length) {
          const h = this.hazards[nh++]; h.visible = true;
          h.position.set(pos.x - ln.dir.x * (c.len / 2 + 3), 1.7, pos.z - ln.dir.z * (c.len / 2 + 3));
          h.material.color.setHex(Math.floor(now * 3) % 2 ? 0xff8a1f : 0xffd23f);
        }
        n++;
      }
    }
    for (let k = nb; k < this.beacons.length; k++) { this.beacons[k].visible = false; this.pins[k].visible = false; }
    for (let k = nh; k < this.hazards.length; k++) this.hazards[k].visible = false;
    for (const im of [this.carBody, this.carCabin, this.carWheels, this.carTail]) {
      im.count = n; im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    // selection + pulses
    const sel = sim.byId[this.selectedId];
    if (sel) {
      this.selRing.visible = true;
      this.selRing.position.set(sel.x, 0.15, sel.z);
      this.selRing.material.opacity = 0.55 + 0.35 * Math.sin(now * 4);
    }
    this.pulses = this.pulses.filter(pl => {
      pl.age += dt;
      const k = pl.age / 1.1;
      pl.m.scale.setScalar(1 + k * 1.6);
      pl.m.material.opacity = Math.max(0, 0.9 * (1 - k));
      if (k >= 1) { this.scene.remove(pl.m); pl.m.material.dispose(); return false; }
      return true;
    });
    if (this.labels) this._updateLabels(labelInfo || {});
  }

  _updateLabels(info) {
    const w = this.el.clientWidth, h = this.el.clientHeight, v = new T.Vector3();
    for (const it of this.sim.intersections) {
      v.set(it.x, 16, it.z).project(this.camera);
      const el = this.labels[it.id];
      el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
      const i = info[it.id] || {};
      el.classList.toggle('sel', it.id === this.selectedId);
      el.classList.toggle('thinking', !!i.thinking);
      el.classList.toggle('emergency', !!i.emergency);
      const ns = this.sim.light(it, 'N'), ew = this.sim.light(it, 'E');
      const plus = el.children[1];
      if (plus.dataset.s !== ns + ew) { plus.dataset.s = ns + ew; plus.children[0].className = 'v ' + ns[0]; plus.children[1].className = 'h ' + ew[0]; }
      el.classList.toggle('flash', !!i.flash);
      const span = el.lastChild;
      const txt = i.text || '';
      if (span.textContent !== txt) span.textContent = txt;
    }
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

function scaleUV(geo, w, h, d) {
  const uv = geo.attributes.uv;
  // BoxGeometry faces: +x, -x, +y, -y, +z, -z (4 verts each)
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k;
    uv.setXY(i, uv.getX(i) * Math.max(1, Math.round(dims[f][0] / 3.4)), uv.getY(i) * Math.max(1, Math.round(dims[f][1] / 3.6)));
  }
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

global.CityView = CityView;
})(window);
