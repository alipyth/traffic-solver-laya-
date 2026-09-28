/* Laya playground + tutorial page. Standalone: talks only to /api/laya/predict and /api/status. */
'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const fa = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const pct = v => fa(Math.round(v * 100)) + '٪';

// ------------------------------------------------------------------ presets
// criteria text format: choice → "label: description" per line; score → one level per line (lowest first);
// noul → optional "true: ..." / "false: ..." lines.
const PRESETS = [
  { name: '🎧 پشتیبانی مشتری', state: 'Hi, we were billed twice for March. Please refund the duplicate today or we will cancel our plan.', qs: [
    { id: 'department', type: 'choice', ins: 'Which department should handle this?', crit: 'billing: invoices, payments, refunds\ntechnical: bugs, outages, system errors\nother: everything else' },
    { id: 'urgency', type: 'score', ins: 'How urgent is this?', crit: 'not urgent\nsoon\nblocking' },
    { id: 'churn_risk', type: 'noul', ins: 'Does the user threaten to cancel or leave?', crit: '' },
  ] },
  { name: '🛡 ایمنی محتوا', state: 'Nobody asked for your opinion. Delete your account or I will make you regret it.', qs: [
    { id: 'category', type: 'choice', ins: 'Which policy does this message break?', crit: 'threat: says something bad will happen to the reader\nharassment: insults or bullies without a threat\nspam: promotes a product or link\nsafe: nothing harmful' },
    { id: 'is_threat', type: 'noul', ins: 'Does the message threaten the reader?', crit: '' },
    { id: 'severity', type: 'score', ins: 'How harmful is this message?', crit: 'harmless\nrude\nabusive\ndangerous' },
  ] },
  { name: '🧭 انتخاب مدل LLM', state: 'Prove that there are infinitely many primes, then write a Python function that lists the first n primes.', qs: [
    { id: 'route', type: 'choice', ins: 'Which model should answer this request?', crit: 'small: a quick fact, greeting or simple question\nlarge: math proofs, programming or multi-step reasoning\ntool: needs live data like weather, news or prices' },
    { id: 'needs_code', type: 'noul', ins: 'Does the user ask for a program or code?', crit: '' },
    { id: 'difficulty', type: 'score', ins: 'How difficult is this request?', crit: 'easy\nmedium\nhard' },
  ] },
  { name: '⭐ تحلیل نظر (نمونه‌ی خطا)', note: 'جواب درست این نمونه «mixed» است (هم تعریف دارد هم شکایت)، ولی مدل پایه معمولاً «negative» می‌گوید. مدل پایه بدون fine-tune اشتباه هم می‌کند؛ برای کار جدی روی داده‌ی حوزه‌ی خودت fine-tune کن و با answer_confidence آستانه بگذار.', state: 'The battery lasts two days and the screen is gorgeous, but the charger broke after a week.', qs: [
    { id: 'sentiment', type: 'choice', ins: 'What is the overall sentiment of the review?', crit: 'positive: mostly praise\nnegative: mostly complaints\nmixed: both praise and complaints' },
    { id: 'defect', type: 'noul', ins: 'Does the review mention a broken or faulty part?', crit: '' },
    { id: 'stars', type: 'score', ins: 'How many stars would this reviewer give?', crit: '1 star\n2 stars\n3 stars\n4 stars\n5 stars' },
  ] },
  { name: '📦 ورودی JSON', state: JSON.stringify({ order_id: 'A-1042', status: 'delayed', days_late: 6, customer_tier: 'gold', previous_complaints: 2 }, null, 2), qs: [
    { id: 'action', type: 'choice', ins: 'What should support do about this order?', crit: 'apology: send an apology email\nvoucher: offer a discount voucher\nrefund: refund the order\nescalate: escalate to a manager' },
    { id: 'vip_risk', type: 'noul', ins: 'Is a valuable customer at risk of leaving?', crit: '' },
  ] },
  { name: '🚦 چراغ راهنمایی', state: 'North-south traffic is heavy. East-west traffic is light. More cars are waiting on the north-south road. An ambulance is coming on the east-west road.', qs: [
    { id: 'green', type: 'choice', ins: 'Give the green light to the busier road; an ambulance always gets green first.', crit: 'ns: north-south road\new: east-west road' },
  ] },
];

let qs = [];
let codeMode = 'py', currentNote = '';

// ------------------------------------------------------------------ question builder
function renderPresets() {
  $('#presets').innerHTML = PRESETS.map((p, i) => `<button class="preset" data-i="${i}">${p.name}</button>`).join('');
  $$('.preset').forEach(b => b.onclick = () => loadPreset(+b.dataset.i));
}
function loadPreset(i) {
  const p = PRESETS[i];
  $('#state').value = p.state;
  qs = p.qs.map(q => ({ ...q }));
  $$('.preset').forEach(b => b.classList.toggle('active', +b.dataset.i === i));
  renderQuestions(); onStateInput(); updateCode();
  currentNote = p.note || '';
  $('#results').innerHTML = '<p class="muted">«بپرس از Laya» را بزن.</p>'; $('#meta').textContent = '';
}
const CRIT_HELP = {
  choice: 'هر خط یک گزینه: label: توضیح',
  score: 'هر خط یک سطح، از کم به زیاد',
  noul: 'اختیاری: true: … و false: …',
};
function renderQuestions() {
  $('#questions').innerHTML = qs.map((q, i) => `
    <div class="q-card" data-i="${i}">
      <div class="q-row">
        <input dir="ltr" data-f="id" value="${esc(q.id)}" placeholder="question_id">
        <select data-f="type">${['choice', 'score', 'noul'].map(t => `<option ${t === q.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <button class="q-del" title="حذف">✕</button>
      </div>
      <input dir="ltr" data-f="ins" value="${esc(q.ins)}" placeholder="instructions: the question, in English">
      <label>${CRIT_HELP[q.type]}</label>
      <textarea dir="ltr" data-f="crit" rows="${Math.max(2, (q.crit.match(/\n/g) || []).length + 1)}">${esc(q.crit)}</textarea>
    </div>`).join('');
  $$('.q-card').forEach(card => {
    const i = +card.dataset.i;
    card.querySelectorAll('[data-f]').forEach(el => el.oninput = () => {
      qs[i][el.dataset.f] = el.value;
      if (el.dataset.f === 'type') renderQuestions();
      updateCode();
    });
    card.querySelector('.q-del').onclick = () => { qs.splice(i, 1); renderQuestions(); updateCode(); };
  });
}

function parseCriteria(q) {
  const lines = q.crit.split('\n').map(l => l.trim()).filter(Boolean);
  if (q.type === 'score') return lines;
  const pairs = lines.map(l => { const k = l.indexOf(':'); return k > 0 ? [l.slice(0, k).trim(), l.slice(k + 1).trim()] : [l, null]; });
  if (q.type === 'noul') return pairs.length ? Object.fromEntries(pairs.filter(([k]) => /^(true|false)$/i.test(k)).map(([k, v]) => [k.toLowerCase(), v || k])) : null;
  return pairs.every(([, v]) => v === null) ? pairs.map(([k]) => k) : Object.fromEntries(pairs.map(([k, v]) => [k, v || k]));
}
function buildQuestions() {
  const out = {};
  for (const q of qs) {
    if (!q.id.trim()) continue;
    const def = { type: q.type, instructions: q.ins };
    const c = parseCriteria(q);
    if (c && (Array.isArray(c) ? c.length : Object.keys(c).length)) def.criteria = c;
    out[q.id.trim()] = def;
  }
  return out;
}
function readState() {
  const raw = $('#state').value.trim();
  if (/^[{[]/.test(raw)) { try { return JSON.parse(raw); } catch { /* plain text */ } }
  return raw;
}
function onStateInput(e) { if (e) currentNote = ''; $('#langWarn').hidden = !/[؀-ۿ]/.test($('#state').value); updateCode(); }

// ------------------------------------------------------------------ code generation
function pyLiteral(v, indent = 0) {
  return JSON.stringify(v, null, 4).replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None')
    .split('\n').join('\n' + ' '.repeat(indent));
}
function updateCode() {
  const state = readState(), questions = buildQuestions();
  let code;
  if (codeMode === 'py') {
    code = `import laya\n\nagent = laya.load("convaiinnovations/laya")   # load once, reuse\n\nstate = ${pyLiteral(state)}\nquestions = ${pyLiteral(questions)}\n\nresult = agent.predict(state, questions)\nfor qid, ans in result["answers"].items():\n    print(qid, ans)`;
  } else if (codeMode === 'curl') {
    const body = JSON.stringify({ state, questions }).replace(/'/g, "'\\''");
    code = `# pip install "laya[serve]" && laya-serve\ncurl -X POST http://localhost:8000/v1/systemone \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
  } else {
    code = JSON.stringify({ state, questions }, null, 2);
  }
  $('#code').textContent = code;
}

// ------------------------------------------------------------------ run
async function run() {
  const body = { state: readState(), questions: buildQuestions() };
  if (!Object.keys(body.questions).length) { $('#results').innerHTML = '<div class="err">حداقل یک سؤال با شناسه لازم است.</div>'; return; }
  const btn = $('#run'); btn.disabled = true; btn.textContent = 'در حال پرسیدن…';
  try {
    const r = await fetch('/api/laya/predict', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { $('#results').innerHTML = `<div class="err">${esc(d.error || d.detail || r.statusText)}</div>`; $('#meta').textContent = ''; return; }
    renderResults(d, body.questions);
  } catch (e) {
    $('#results').innerHTML = `<div class="err">${esc(e)}</div>`;
  } finally { btn.disabled = false; btn.textContent = '⚡ بپرس از Laya'; }
}

function bars(probs, winner, labelOf = k => k) {
  return Object.entries(probs).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
    `<div class="bar ${k === winner ? 'win' : ''}"><span title="${esc(labelOf(k))}">${esc(labelOf(k))}</span><div class="track"><i style="width:${(v * 100).toFixed(1)}%"></i></div><span>${pct(v)}</span></div>`).join('');
}
function renderResults(d, questions) {
  const tokens = d.usage && d.usage.input_tokens;
  $('#meta').textContent = `${fa(d.latency_ms)} ms · ${tokens ? fa(tokens) + ' توکن ورودی · ' : ''}${d.device || ''}`;
  $('#results').innerHTML = Object.entries(d.answers).map(([id, a]) => {
    const conf = a.answer_confidence != null ? `<small>اطمینان ${pct(a.answer_confidence)}</small>` : '';
    if (a.type === 'choice') {
      return `<div class="res"><div class="res-h"><code>${esc(id)}</code><span class="ans" dir="ltr">${esc(a.choice)}</span>${conf}</div>${bars(a.probabilities, a.choice)}</div>`;
    }
    if (a.type === 'score') {
      const legend = a.legend || {}, k = Object.keys(a.probabilities).length;
      const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0][0];
      return `<div class="res"><div class="res-h"><code>${esc(id)}</code><span class="ans">${fa(a.score.toFixed(2))} <span class="muted">از ${fa(k - 1)}</span></span>${conf}</div>
        ${bars(a.probabilities, top, i => `${i} · ${legend[i] || ''}`)}</div>`;
    }
    const yes = a.noul;
    return `<div class="res"><div class="res-h"><code>${esc(id)}</code><span class="ans">${yes >= 0.5 ? 'بله' : 'نه'} <span class="muted">(احتمال بله ${pct(yes)})</span></span>${conf}</div>
      <div class="gauge"><i style="width:${(yes * 100).toFixed(1)}%"></i></div></div>`;
  }).join('') + (currentNote ? `<div class="warn">${esc(currentNote)}</div>` : '');
}

// ------------------------------------------------------------------ misc
async function pollStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    const map = { ready: ['ok', `مدل آماده · ${s.laya.device || 'cpu'}`], loading: ['wait', 'در حال بارگذاری مدل…'], idle: ['wait', 'در انتظار مدل'], error: ['bad', 'مدل بارگذاری نشد'] };
    const [cls, txt] = map[s.laya.status] || map.idle;
    $('#pill').className = 'pill ' + cls; $('#pill').lastChild.textContent = txt; $('#pill').title = s.laya.error || s.laya.model;
    if (s.laya.status !== 'ready' && s.laya.status !== 'error') setTimeout(pollStatus, 2000);
  } catch { $('#pill').className = 'pill bad'; $('#pill').lastChild.textContent = 'سرور در دسترس نیست'; }
}

$('#run').onclick = run;
$('#addQ').onclick = () => { qs.push({ id: `q${qs.length + 1}`, type: 'noul', ins: '', crit: '' }); renderQuestions(); updateCode(); };
$('#state').oninput = onStateInput;
$$('.seg-b').forEach(b => b.onclick = () => { codeMode = b.dataset.code; $$('.seg-b').forEach(x => x.classList.toggle('active', x === b)); updateCode(); });
$('#copyCode').onclick = async () => {
  try { await navigator.clipboard.writeText($('#code').textContent); $('#copyCode').textContent = 'کپی شد ✓'; }
  catch { $('#copyCode').textContent = 'کپی نشد'; }
  setTimeout(() => $('#copyCode').textContent = 'کپی', 1500);
};
$$('[data-tabs] .t').forEach(b => b.onclick = () => {
  $$('[data-tabs] .t').forEach(x => x.classList.toggle('active', x === b));
  $$('.os').forEach(p => p.hidden = !p.classList.contains(b.dataset.os));
});
renderPresets();
loadPreset(0);
pollStatus();
