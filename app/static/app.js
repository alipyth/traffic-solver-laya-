/* Traffic AI Lab — UI glue: simulation loop, brains (Laya / slow Laya / LLM / fixed timer), panels. */
'use strict';
// Show script errors on the page instead of silently freezing.
function showError(msg) {
  let el = document.getElementById('errToast');
  if (!el) { el = document.createElement('div'); el.id = 'errToast'; document.body.appendChild(el); }
  el.textContent = '⚠ خطا: ' + msg;
}
window.addEventListener('error', e => showError(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', e => showError(String(e.reason && e.reason.stack || e.reason)));
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const fa = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '—' : fa(Number(n).toFixed(d));
const AX_FA = { ns: 'شمال–جنوب', ew: 'شرق–غرب' };
const AX_ICON = { ns: '↕', ew: '↔' };
const DIR_FA = { N: 'شمال', S: 'جنوب', E: 'شرق', W: 'غرب' };
const { axisOf, MIN_GREEN } = SIMCONST;
const SEED = 7, FIXED_CYCLE = 30, SLOW_DELAY = 4, MIN_GAP_MS = 250;

let running = true, speed = 1, tab = 'live';
let llmReady = false, layaModelMs = null;

// ------------------------------------------------------------------ cities
function warm(sim) {
  // Fill the streets for 40 s with a plain fixed cycle so the city starts alive (identical for every city).
  for (let k = 0; k < 40 * 60; k++) {
    if (k % 180 === 0) for (const it of sim.intersections) sim.setDesired(it.id, Math.floor(sim.t / FIXED_CYCLE) % 2 ? 'ew' : 'ns');
    sim.advance(1 / 60);
  }
  for (const it of sim.intersections) sim.setDesired(it.id, null);
  Object.assign(sim, { throughput: 0, diverted: 0, exitTimes: [], recentDelays: [], history: [], events: [], ambulanceTrips: [] });
}

function freshState() {
  return { pending: false, lastAskReal: 0, decisions: {}, feed: [], lastLatency: null, stats: null, asks: 0,
    lastSource: '', lastError: '', delayed: [], flash: {} };
}
function makeCity(brain) {
  const sim = new TrafficSim(SEED);
  warm(sim);
  return { sim, brain, ...freshState() };
}
function resetCity(c) { c.sim.reset(); warm(c.sim); Object.assign(c, freshState()); }

const live = makeCity('laya');
const cmpL = makeCity('laya');
const cmpR = makeCity('slow');
let selected = 'B2';
live.view = new CityView($('#liveScene'), live.sim, { labels: true, onSelect: id => select(id) });

// ------------------------------------------------------------------ brains
function applyDecision(city, s, d, meta) {
  const sim = city.sim, it = sim.byId[s.id];
  const emAxis = s.emergency_dir ? axisOf(s.emergency_dir) : null;
  const before = it.signal.desired || it.signal.axis;
  sim.setDesired(s.id, d.axis, emAxis === d.axis);
  const rec = { ...d, sensors: s, ...meta, switch: d.axis !== before, emergency: !!emAxis };
  city.decisions[s.id] = rec;
  if (rec.switch || rec.emergency) {
    city.flash[s.id] = performance.now();
    if (city.view && rec.switch) city.view.pulse(s.id, emAxis ? 0xff5b5b : 0x7ef9ff);
  }
  if (rec.switch) {
    const p = d.probabilities && d.probabilities[d.axis];
    city.feed.unshift({ t: sim.clock(), kind: rec.emergency ? 'em' : 'dec',
      text: `<b>${s.id}</b> · ${esc(d.reason)}${p ? ` <span class="c">${fmt(p * 100)}٪</span>` : ''}` });
    if (city.feed.length > 40) city.feed.pop();
  }
}

async function ask(city) {
  const sim = city.sim, gen = sim.gen;
  if (city.brain === 'fixed') {
    for (const it of sim.intersections) sim.setDesired(it.id, Math.floor(sim.t / FIXED_CYCLE) % 2 ? 'ew' : 'ns');
    city.lastSource = 'fixed';
    return;
  }
  if (city.brain === 'llm' && !llmReady) { city.lastSource = 'llm-disabled'; return; }
  const sensors = sim.allSensors();
  const askedAt = sim.t, askedClock = sim.clock();
  city.pending = true; city.asks++; city.lastAskReal = performance.now();
  try {
    const r = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brain: city.brain === 'llm' ? 'llm' : 'laya', intersections: sensors }) });
    const data = await r.json();
    if (sim.gen !== gen) return;
    city.lastSource = data.source; city.lastError = data.error || '';
    if (data.source === 'llm-error') return;
    city.lastLatency = data.latency_ms; city.stats = data.stats || null;
    const meta = { t: askedClock, askedAt, latency: data.latency_ms, source: data.source };
    if (city.brain === 'slow') {
      // Same answer, delivered as late as a typical LLM would deliver it.
      city.delayed.push({ at: askedAt + SLOW_DELAY, sensors, data, meta });
    } else {
      for (const s of sensors) if (data.decisions[s.id]) applyDecision(city, s, data.decisions[s.id], meta);
    }
  } catch (e) {
    city.lastError = String(e);
  } finally {
    city.pending = false;
  }
}

function tickBrain(city) {
  while (city.delayed.length && city.delayed[0].at <= city.sim.t) {
    const job = city.delayed.shift();
    for (const s of job.sensors) if (job.data.decisions[s.id]) applyDecision(city, s, job.data.decisions[s.id], job.meta);
  }
  if (city.pending || city.delayed.length) return;
  if (city.brain === 'fixed' || performance.now() - city.lastAskReal >= MIN_GAP_MS) ask(city);
}

// ------------------------------------------------------------------ demo story
const DEMO = [[4, 'ambulance'], [18, 'rush'], [40, 'ambulance'], [65, 'accident'], [90, 'ambulance'], [120, 'ambulance'], [150, 'normal'], [165, 'ambulance']];
let demo = null;
function stopDemo() { demo = null; $('#demoBtn').classList.remove('on'); $('#demoBtn').textContent = '🎬 دموی خودکار'; }
function startDemo() {
  const cities = tab === 'compare' ? [cmpL, cmpR] : [live];
  demo = { start: cities[0].sim.t, cities, idx: 0 };
  $('#demoBtn').classList.add('on');
}
function tickDemo() {
  if (!demo) return;
  const el = demo.cities[0].sim.t - demo.start;
  while (demo.idx < DEMO.length && el >= DEMO[demo.idx][0]) {
    for (const c of demo.cities) c.sim.scenario(DEMO[demo.idx][1]);
    demo.idx++;
  }
  if (demo.idx >= DEMO.length) stopDemo();
  else $('#demoBtn').textContent = `🎬 دمو ${fa(demo.idx)}/${fa(DEMO.length)} · توقف`;
}

// ------------------------------------------------------------------ main loop
let last = performance.now(), uiAcc = 0, fps = 60;
function frame(now) {
  const raw = (now - last) / 1000; last = now;
  const dt = Math.min(0.25, raw);   // the sim steps at 60 Hz internally, so it keeps real time even at low fps
  fps = fps * 0.95 + (raw > 0 ? 1 / raw : 60) * 0.05;
  const cities = tab === 'live' ? [live] : tab === 'compare' ? [cmpL, cmpR] : [];
  if (running) {
    for (const c of cities) { c.sim.advance(dt * speed); tickBrain(c); }
    tickDemo();
  }
  for (const c of cities) {
    if (!c.view) continue;
    c.view.update(dt, c === live ? labelInfo() : null);
    c.view.render();
  }
  uiAcc += dt;
  if (uiAcc > 0.25) { uiAcc = 0; if (tab === 'live') renderLive(); else if (tab === 'compare') renderCompare(); }
  requestAnimationFrame(frame);
}

function labelInfo() {
  const out = {}, now = performance.now();
  for (const it of live.sim.intersections) {
    const d = live.decisions[it.id], s = it.signal;
    const flash = !!(live.flash[it.id] && now - live.flash[it.id] < 1800 && d && d.switch);
    let text = '';
    if (s.desired && s.desired !== s.axis && s.state === 'green') text = `→ ${AX_ICON[s.desired]}`;
    out[it.id] = { flash, emergency: !!(d && d.emergency), text };
  }
  return out;
}

// ------------------------------------------------------------------ live panels
function select(id) { selected = id; live.view.selectedId = id; renderLive(); }

function cityStatus(m) {
  if (m.cars === 0) return ['⚪', 'خالی', 'هنوز ماشینی وارد نشده.', 'calm'];
  const stoppedShare = m.queued / m.cars;
  if (m.speedKmh >= 20 && stoppedShare < 0.4) return ['✅', 'روان', 'بیشتر ماشین‌ها در حرکت‌اند و صف‌ها کوتاه‌اند.', 'ok'];
  if (m.speedKmh >= 13) return ['🟡', 'شلوغ', 'پشت چراغ‌ها صف هست ولی شهر در حال حرکت است.', 'mid'];
  if (m.speedKmh >= 8) return ['🟠', 'سنگین', 'بیشتر ماشین‌ها ایستاده‌اند؛ Laya خیابان‌های پرتر را اول باز می‌کند.', 'hi'];
  return ['🔴', 'تقریباً قفل', 'صف‌ها به چهارراه قبلی رسیده‌اند. «✓ عادی» را بزن یا صبر کن تا تخلیه شود.', 'bad'];
}

function renderLive() {
  const sim = live.sim, m = sim.metrics();
  $('#clock').textContent = fa(sim.clock());
  $('#fps').textContent = `${fa(Math.round(fps))} fps`;
  $('#fps').classList.toggle('low', fps < 25);
  // 1. city status
  const [icon, word, text, cls] = cityStatus(m);
  $('#stIcon').textContent = icon; $('#stWord').textContent = word; $('#stText').textContent = text;
  $('#statusCard').dataset.level = cls;
  const amb = m.ambulanceStopped;
  $('#stTrio').innerHTML = [
    ['ماشین ایستاده', fmt(m.queued), `از ${fmt(m.cars)} ماشین`],
    ['سرعت میانگین', fmt(m.speedKmh), 'کیلومتر بر ساعت'],
    ['آمبولانس آخر', amb == null ? '—' : fmt(amb, 1), amb == null ? 'هنوز نیامده' : 'ثانیه پشت چراغ ماند'],
  ].map(([a, b, c]) => `<div><small>${a}</small><b>${b}</b><em>${c}</em></div>`).join('');
  // 2. Laya speed
  $('#spdMs').textContent = live.lastLatency == null ? '—' : fmt(live.lastLatency);
  $('#spdText').innerHTML = live.lastSource === 'reference-fallback' ? 'Laya در دسترس نیست؛ قاعده‌ی مرجع تصمیم می‌گیرد.' :
    !live.asks ? 'منتظر اولین تصمیم…' :
    `هر ۰٫۲۵ ثانیه وضعیت هر ۹ چهارراه دوباره از Laya پرسیده می‌شود (${fmt(live.asks)} بار تا الان).` +
    (layaModelMs ? ` خود مدل روی این CPU برای هر وضعیت تازه ~${fmt(layaModelMs)} ms وقت می‌گذارد؛ چون کل جمله‌های ممکن فقط ۱۰۵ تاست، پاسخ همه یک بار از مدل گرفته و نگه داشته می‌شود.` : '') +
    ' <b>هرچه سریع‌تر، آمبولانس کمتر پشت چراغ می‌ماند.</b>';
  // 3. selected intersection
  const it = sim.byId[selected], s = sim.sensors(it), d = live.decisions[selected];
  $('#ixId').textContent = selected;
  const cell = dir => {
    const light = sim.light(it, dir), arrow = { N: '↓', S: '↑', E: '←', W: '→' }[dir];
    const tag = s.emergency_dir === dir ? ' 🚑' : s.blocked_dir === dir ? ' 💥' : '';
    return `<div class="appr ${light}"><span>از ${DIR_FA[dir]} ${arrow}${tag}</span><b>${fmt(s.queues[dir])}</b><small>ماشین منتظر</small></div>`;
  };
  const ns = sim.light(it, 'N'), ew = sim.light(it, 'E');
  $('#ixCross').innerHTML = `<div></div>${cell('N')}<div></div>${cell('W')}<div class="mid"><i class="plus big"><i class="v ${ns[0]}"></i><i class="h ${ew[0]}"></i></i></div>${cell('E')}<div></div>${cell('S')}<div></div>`;
  $('#ixSaw').textContent = d ? d.state_fa : '—';
  $('#ixText').textContent = d ? d.state_text : '—';
  if (d) {
    const p = d.probabilities && d.probabilities[d.axis];
    $('#ixSaid').innerHTML = `${esc(d.reason)}${p ? ` <span class="conf">اطمینان ${fmt(p * 100)}٪</span>` : ''}`;
  } else $('#ixSaid').textContent = '—';
  const sg = it.signal;
  let lt = sg.state === 'green' ? `سبز برای ${AX_FA[sg.axis]} ${AX_ICON[sg.axis]} (${fmt(sg.t)} ثانیه)` :
    sg.state === 'yellow' ? `زرد برای ${AX_FA[sg.axis]}؛ در حال عوض شدن` : 'همه قرمز (۱٫۲ ثانیه تا خالی شدن چهارراه)';
  if (sg.desired && sg.desired !== sg.axis && sg.state === 'green') {
    const left = Math.max(0, (sg.urgent ? 1.5 : MIN_GREEN) - sg.t);
    lt += `<br><span class="soon">Laya گفته سبز به ${AX_FA[sg.desired]} برسد؛ ${left > 0 ? `${fmt(left)} ثانیه دیگر` : 'الان'} (برای ایمنی هر سبز حداقل ${fa(MIN_GREEN)} ثانیه می‌ماند).</span>`;
  }
  $('#ixLight').innerHTML = lt;
  // 4. feed: decisions that changed a light + city events
  const items = [...live.feed.slice(0, 14), ...sim.events.slice(0, 8).map(e => ({ t: e.t, kind: 'ev ' + e.type, text: esc(e.text) }))]
    .sort((a, b) => b.t.localeCompare(a.t)).slice(0, 16);
  $('#feed').innerHTML = items.length ? items.map(x => `<div class="fi ${x.kind}"><span class="tm">${fa(x.t.slice(3))}</span><span>${x.text}</span></div>`).join('')
    : '<div class="muted">وقتی Laya چراغی را عوض کند اینجا نوشته می‌شود.</div>';
}

// ------------------------------------------------------------------ charts
function lineChart(el, series) {
  const W = el.clientWidth || 300, H = el.clientHeight || 120, pad = 26;
  const all = series.flatMap(s => s.values);
  if (!all.length) { el.innerHTML = ''; return; }
  const max = Math.max(10, ...all) * 1.1, n = Math.max(...series.map(s => s.values.length));
  const x = i => pad + (i / Math.max(1, n - 1)) * (W - pad - 6), y = v => H - 14 - (v / max) * (H - 24);
  const grid = [0, 0.5, 1].map(k => { const v = max * k; return `<line x1="${pad}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#243239"/><text x="0" y="${y(v) + 4}" fill="#8aa09c" font-size="10">${fa(v.toFixed(0))}</text>`; }).join('');
  const lines = series.map(s => {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const lv = s.values[s.values.length - 1];
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round"/>` +
      (s.values.length ? `<circle cx="${x(s.values.length - 1)}" cy="${y(lv)}" r="3.5" fill="${s.color}"/>` : '');
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${lines}</svg>`;
}

// ------------------------------------------------------------------ compare
const RIGHT_NAMES = { slow: ['🐢 Laya با ۴ ثانیه تأخیر', 'با تأخیر'], fixed: ['⏱ چراغ زمان‌ثابت', 'زمان‌ثابت'], llm: ['🧠 LLM واقعی', 'LLM'] };
function ensureCompareViews() {
  if (cmpL.view) return;
  cmpL.view = new CityView($('#cmpLeft'), cmpL.sim, { pixelRatio: 1.5 });
  cmpR.view = new CityView($('#cmpRight'), cmpR.sim, { pixelRatio: 1.5 });
  for (const v of [cmpL.view, cmpR.view]) { v.selectedId = null; v.selRing.visible = false; v.camera.zoom = 1.2; v.camera.updateProjectionMatrix(); }
}
const ambAvg = s => s.ambulanceTrips.length ? s.ambulanceTrips.reduce((x, y) => x + y.stopped, 0) / s.ambulanceTrips.length : null;
function cityKpis(c) {
  const m = c.sim.metrics(), a = ambAvg(c.sim);
  return [['ماشین ایستاده', fmt(m.queued)], ['سرعت میانگین', fmt(m.speedKmh) + ' km/h'],
    ['آمبولانس پشت چراغ', a == null ? '—' : fmt(a, 1) + ' ثانیه'], ['ماشین عبورکرده', fmt(m.throughput)]]
    .map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
}
function brainLabel(c) {
  if (c.brain === 'fixed') return 'هر ۳۰ ثانیه عوض می‌شود؛ حسگر ندارد';
  if (c.brain === 'llm' && !llmReady) return 'LLM تنظیم نشده — از ⚙ بالای صفحه تنظیم کن';
  if (c.lastSource === 'llm-error') return 'خطای LLM: ' + c.lastError.slice(0, 70);
  if (c.brain === 'slow') return `همان تصمیم Laya، ${fa(SLOW_DELAY)} ثانیه دیرتر اجرا می‌شود`;
  return 'تصمیم پیوسته، هر ۰٫۲۵ ثانیه';
}
function renderCompare() {
  const lat = c => c.lastLatency == null ? '—' : fmt(c.lastLatency) + ' ms';
  $('#cmpLeftSrc').textContent = brainLabel(cmpL);
  $('#cmpRightSrc').textContent = brainLabel(cmpR);
  $('#cmpLeftLat').textContent = lat(cmpL);
  $('#cmpRightLat').textContent = cmpR.brain === 'fixed' ? '—' : cmpR.brain === 'slow' ? fmt(SLOW_DELAY * 1000) + ' ms' : lat(cmpR);
  $('#cmpLeftK').innerHTML = cityKpis(cmpL);
  $('#cmpRightK').innerHTML = cityKpis(cmpR);
  lineChart($('#cmpChart'), [{ values: cmpL.sim.history.map(p => p.queued), color: '#36e3b4' }, { values: cmpR.sim.history.map(p => p.queued), color: '#f5b54a' }]);
  const a = cmpL.sim.metrics(), b = cmpR.sim.metrics();
  const rows = [
    ['آمبولانس به‌طور میانگین چند ثانیه پشت چراغ ماند', ambAvg(cmpL.sim), ambAvg(cmpR.sim), -1, 1],
    ['ماشین‌های ایستاده (الان)', a.queued, b.queued, -1, 0],
    ['ماشین‌هایی که از شهر عبور کردند', a.throughput, b.throughput, 1, 0],
  ];
  $('#cmpTable').innerHTML = `<table><tr><th></th><th>Laya سریع</th><th>${RIGHT_NAMES[cmpR.brain][1]}</th></tr>` + rows.map(([n, x, y, dir, dg]) => {
    const bx = x != null && y != null && (dir > 0 ? x > y : x < y), by = x != null && y != null && (dir > 0 ? y > x : y < x);
    return `<tr><td>${n}</td><td class="num ${bx ? 'best' : ''}">${fmt(x, dg)}</td><td class="num ${by ? 'best o' : ''}">${fmt(y, dg)}</td></tr>`;
  }).join('') + '</table>';
}

// ------------------------------------------------------------------ status + settings
async function pollStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    llmReady = s.llm.ready;
    const pw = s.laya.prewarm || {}, warming = s.laya.status === 'ready' && pw.total && pw.done < pw.total;
    layaModelMs = s.laya.model_ms_per_sentence;
    const map = { ready: warming ? ['wait', `Laya آماده · پیش‌محاسبه ${fa(pw.done)}/${fa(pw.total)}`] : ['ok', 'Laya آماده است'], loading: ['wait', 'Laya در حال بارگذاری مدل…'],
      idle: ['wait', 'Laya در انتظار'], error: ['bad', 'Laya بارگذاری نشد → قاعده‌ی مرجع'] };
    const [cls, txt] = map[s.laya.status] || map.idle;
    const pill = $('#layaPill');
    pill.className = 'pill ' + cls; pill.lastChild.textContent = txt;
    pill.title = s.laya.error || `${s.laya.model} روی ${s.laya.device || 'cpu'}`;
    $('#rightBrain').options[2].textContent = llmReady ? `LLM واقعی (${s.llm.model})` : 'LLM واقعی (تنظیم نشده)';
    if (s.laya.status === 'loading' || s.laya.status === 'idle' || warming) setTimeout(pollStatus, 1500);
  } catch { $('#layaPill').className = 'pill bad'; $('#layaPill').lastChild.textContent = 'سرور در دسترس نیست'; setTimeout(pollStatus, 3000); }
}

function bindUi() {
  $$('.tab').forEach(b => b.onclick = () => {
    tab = b.dataset.tab;
    $$('.tab').forEach(x => x.classList.toggle('active', x === b));
    $$('.page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
    $('#controls').style.visibility = tab === 'how' ? 'hidden' : 'visible';
    if (tab === 'compare') { ensureCompareViews(); renderCompare(); }
    if (tab === 'live') renderLive();
    if (tab === 'how') playAsk();
    history.replaceState(null, '', '#' + tab);
    stopDemo();
    last = performance.now();
  });
  $('#playBtn').onclick = () => { running = !running; $('#playBtn').textContent = running ? '⏸ توقف' : '▶ ادامه'; };
  $('#resetBtn').onclick = () => { for (const c of (tab === 'compare' ? [cmpL, cmpR] : [live])) resetCity(c); stopDemo(); };
  $$('#speeds .chip').forEach(b => b.onclick = () => { speed = +b.dataset.speed; $$('#speeds .chip').forEach(x => x.classList.toggle('active', x === b)); });
  $$('#scenarios button').forEach(b => b.onclick = () => { for (const c of (tab === 'compare' ? [cmpL, cmpR] : [live])) c.sim.scenario(b.dataset.scenario); });
  $('#demoBtn').onclick = () => { if (demo) stopDemo(); else startDemo(); };
  $('#camBtn').onclick = () => live.view.resetCamera();
  $('#rightBrain').onchange = e => {
    cmpR.brain = e.target.value;
    $('#cmpRightName').textContent = RIGHT_NAMES[cmpR.brain][0];
    $('#cmpLegend').textContent = RIGHT_NAMES[cmpR.brain][1];
    resetCity(cmpL); resetCity(cmpR); stopDemo();
  };
  // LLM settings
  $('#settingsBtn').onclick = () => { $('#settingsModal').hidden = false; };
  $('#closeSettings').onclick = () => { $('#settingsModal').hidden = true; };
  const settings = () => ({ provider: $('#provider').value, base_url: $('#baseUrl').value.trim(), model: $('#modelName').value.trim(), api_key: $('#apiKey').value });
  const save = async () => {
    const r = await (await fetch('/api/llm/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings()) })).json();
    llmReady = r.ready;
    $('#llmResult').textContent = r.ready ? 'ذخیره شد. در تب «چرا سرعت مهم است؟» شهر دوم را «LLM واقعی» بگذار.' : 'ذخیره شد ولی LLM خاموش است.';
    pollStatus();
  };
  $('#saveLlm').onclick = save;
  $('#testLlm').onclick = async () => {
    await save();
    $('#llmResult').textContent = 'در حال تست…';
    const r = await (await fetch('/api/llm/test', { method: 'POST' })).json();
    $('#llmResult').innerHTML = r.ok ? `<span class="ok">✓ پاسخ در ${fmt(r.latency_ms)} ms: ${esc(r.decision && r.decision.axis)}</span>` : `<span class="no">✗ ${esc(r.error || r.source)}</span>`;
  };
  // playground
  $$('.play-in input').forEach(i => i.oninput = () => { outputs(); debounce(playAsk, 150)(); });
  $('#playAmb').onchange = playAsk;
  outputs();
  $('#benchBtn').onclick = runBench;
}

function outputs() { $$('.play-in input').forEach(i => { i.nextElementSibling.textContent = fa(i.value) + (i.dataset.o ? '٪' : ''); }); }
let _deb = null;
function debounce(fn, ms) { return () => { clearTimeout(_deb); _deb = setTimeout(fn, ms); }; }

function probsHtml(d) {
  const p = d.probabilities || {}, has = Object.keys(p).length > 0;
  return ['ns', 'ew'].map(ax => {
    const v = has ? (p[ax] || 0) : (d.axis === ax ? 1 : 0);
    return `<div class="prob ${d.axis === ax ? 'win' : ''}"><b>${AX_ICON[ax]} ${AX_FA[ax]}</b><div class="track"><i style="width:${(v * 100).toFixed(1)}%"></i></div><span>${fmt(v * 100)}٪</span></div>`;
  }).join('');
}

async function playAsk() {
  const q = {}, occ = {};
  $$('.play-in input[data-q]').forEach(i => q[i.dataset.q] = +i.value);
  $$('.play-in input[data-o]').forEach(i => occ[i.dataset.o] = +i.value / 100);
  const s = { id: 'LAB', queues: q, approaching: { N: 0, S: 0, E: 0, W: 0 }, wait: { N: 0, S: 0, E: 0, W: 0 },
    downstream: { N: occ.ns, S: occ.ns, E: occ.ew, W: occ.ew }, emergency_dir: $('#playAmb').value || null, green_axis: 'ns' };
  try {
    const r = await (await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brain: 'laya', intersections: [s] }) })).json();
    const d = r.decisions.LAB;
    $('#playFa').textContent = d.state_fa;
    $('#playText').textContent = d.state_text;
    $('#playProbs').innerHTML = probsHtml(d);
    const st = r.stats;
    $('#playMeta').innerHTML = `${esc(d.reason)}<br>${fmt(r.latency_ms)} ms · ${st ? (st.fresh ? 'جمله‌ی جدید، مدل اجرا شد' : 'این جمله قبلاً پرسیده شده بود') : esc(r.source)} · قاعده‌ی مرجع: ${d.reference === d.axis ? '<span class="ok">✓ هم‌نظر</span>' : `<span class="no">${AX_FA[d.reference]}</span>`}`;
  } catch (e) { $('#playMeta').textContent = 'خطا: ' + e; }
}

async function runBench() {
  $('#bench').innerHTML = '<p class="muted">در حال اجرا…</p>';
  const r = await (await fetch('/api/benchmark', { method: 'POST' })).json();
  const row = (name, x) => x ? `<tr><td>${name}</td><td class="num">${fa(x.alignment)}٪</td><td class="num">${fa(x.emergency)}</td><td class="num">${fmt(x.per_case_ms)} ms</td></tr>` :
    `<tr><td>${name}</td><td colspan="3" class="muted">تنظیم نشده</td></tr>`;
  $('#bench').innerHTML = `<table><tr><th>مغز</th><th>هم‌نظری با قاعده‌ی مرجع</th><th>آمبولانس درست</th><th>زمان هر وضعیت</th></tr>${row('Laya', r.laya)}${row('LLM', r.llm)}</table>
    <p class="muted">${esc(r.note)}</p>`;
}

// ------------------------------------------------------------------ boot
bindUi();
select('B2');
pollStatus();
const startTab = document.querySelector(`.tab[data-tab="${location.hash.slice(1)}"]`);
if (startTab) startTab.click();
requestAnimationFrame(frame);
