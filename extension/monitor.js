// Breathfold Monitor: holds the heart-rate band, learns a baseline from the first 5 minutes after Chrome starts
// and again at the first use of every new day, then suggests a Breathfold session when heart rate rises or
// variability drops past the chosen limits. Every day is kept per minute for the history below.
const $ = id => document.getElementById(id);
const BASE_MS = 5 * 60 * 1000;       // baseline length
const HR_WIN = 2 * 60 * 1000;        // "now" heart rate: mean of the last 2 minutes
const VAR_WIN = 3 * 60 * 1000;       // "now" variability: the last 3 minutes
const KEEP = 20 * 60 * 1000;
const COOLDOWN = 30 * 60 * 1000;     // at most one suggestion per half hour
const PAUSE = 2 * 60 * 60 * 1000;
const DAY_START_H = 4;               // a day runs from 4 am, so a late evening still belongs to that day
const KEEP_DAYS = 180;

const store = {
  get: keys => chrome.storage.local.get(keys),
  set: obj => chrome.storage.local.set(obj),
};

let settings = { hrDelta: 10, varPct: 60 };
let baseline = null;                 // { start, hr, v, kind: 'rmssd' | 'stv', done }
let samples = [];                    // { t, bpm, rr: [] }
let device = null, connected = false, attaching = false, stopped = false, lastEval = 0, lastAlert = 0, snoozeUntil = 0, pausedUntil = 0;
let today = null;                    // this day's record: { day, bases: [], alerts: [], min: [[minute, bpm, n]], vars: [[minute, v]] }
let curMin = null;                   // the minute being collected: { k, sum, n }
let userActive = true;

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayKey = t => { const d = new Date(t - DAY_START_H * 3600e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---- variability
// With beat-to-beat intervals (chest strap): RMSSD, the standard short-term HRV.
// With bpm only (Fitbit Air): the spread of heart rate around its own 30-second running mean. That keeps the
// breath-to-breath ups and downs and drops slow drifts; a rough stand-in for HRV, only comparable with itself.
function rmssd(rrAll) {
  const rr = rrAll.filter(x => x >= 300 && x <= 2000);
  if (rr.length < 60) return null;
  let sum = 0, n = 0;
  for (let i = 1; i < rr.length; i++) if (Math.abs(rr[i] - rr[i - 1]) / rr[i - 1] <= 0.2) { sum += (rr[i] - rr[i - 1]) ** 2; n++; }
  return n >= 40 ? Math.sqrt(sum / n) : null;
}
function stv(pts) {
  if (pts.length < 100) return null;
  const res = [];
  let lo = 0, hi = 0, sum = 0;
  for (const p of pts) {                     // sliding ±15 s window
    while (hi < pts.length && pts[hi].t <= p.t + 15000) sum += pts[hi++].bpm;
    while (pts[lo].t < p.t - 15000) sum -= pts[lo++].bpm;
    res.push(p.bpm - sum / (hi - lo));
  }
  return sd(res);
}
function variability(pts, kind) {
  return kind === 'rmssd' ? rmssd(pts.flatMap(p => p.rr)) : stv(pts);
}
const since = ms => { const t = Date.now() - ms; return samples.filter(p => p.t >= t); };
// enough readings to trust a window (about one per second, allowing for dropouts)
const covered = (pts, ms) => pts.length >= ms / 1000 * 0.75;

// ---- heart rate over the standard Bluetooth Heart Rate Profile
function parse(dv) {
  const flags = dv.getUint8(0);
  let i = 1;
  const bpm = flags & 0x01 ? dv.getUint16(i, true) : dv.getUint8(i);
  i += flags & 0x01 ? 2 : 1;
  if (flags & 0x08) i += 2;
  const rr = [];
  if (flags & 0x10) for (; i + 1 < dv.byteLength; i += 2) rr.push(dv.getUint16(i, true) * 1000 / 1024);
  return { bpm, rr };
}

function onData(e) {
  const { bpm, rr } = parse(e.target.value);
  if (!(bpm > 0)) return;
  const t = Date.now();
  samples.push({ t, bpm, rr });
  while (samples.length && samples[0].t < t - KEEP) samples.shift();
  const k = Math.floor(t / 60000);
  if (curMin && curMin.k !== k) flushMinute();
  if (!curMin) curMin = { k, sum: 0, n: 0 };
  curMin.sum += bpm; curMin.n++;
  $('bpm').textContent = bpm;
  if (t - lastEval >= 15000) { lastEval = t; evaluate(); }
}

async function attachOnce() {
  const server = await timeout(device.gatt.connect(), 12000, 'no answer from the band');
  await sleep(300);
  if (!server.connected) throw new Error('link dropped');
  const svc = await timeout(server.getPrimaryService('heart_rate'), 8000, 'no heart rate service');
  const ch = await svc.getCharacteristic('heart_rate_measurement');
  ch.addEventListener('characteristicvaluechanged', onData);
  await ch.startNotifications();
}
async function attach() {
  if (attaching) return;
  attaching = true;
  try {
    for (let n = 1; ; n++) {
      try { await attachOnce(); break; }
      catch (err) { try { device.gatt.disconnect(); } catch (e) {} if (n >= 3) throw err; await sleep(600 * n); }
    }
  } finally { attaching = false; }
  connected = true;
  chrome.notifications.clear('reconnect');
  render();
}

async function connect() {
  if (connected) { stopped = true; pausedUntil = 0; device.gatt.disconnect(); return; }
  stopped = false;
  try {
    status('Pick your band in the browser list…');
    device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    device.addEventListener('gattserverdisconnected', onDisconnect);
    await store.set({ deviceId: device.id });
    status('Connecting…');
    await attach();
  } catch (err) {
    status(err.name === 'NotFoundError' ? 'No band chosen' : `Could not connect (${err.message}). Is the band busy with your phone or tablet?`);
  }
}

// the band dropped out (or was released): keep trying quietly, unless paused
let retryTimer = null;
function onDisconnect() {
  connected = false;
  render();
  clearTimeout(retryTimer);
  if (stopped) { status('Disconnected'); return; }
  const retry = async () => {
    if (connected || !device) return;
    if (Date.now() < pausedUntil) { retryTimer = setTimeout(retry, pausedUntil - Date.now() + 1000); return; }
    status('Signal lost, reconnecting…');
    try { await attach(); } catch (e) { status('Band not reachable; trying again every 30 s'); retryTimer = setTimeout(retry, 30000); }
  };
  retryTimer = setTimeout(retry, 3000);
}

// after a Chrome restart, reconnect to the band chosen before without the picker, where Chrome allows it
async function autoReconnect() {
  const { deviceId } = await store.get('deviceId');
  if (!deviceId) return;
  if (navigator.bluetooth.getDevices) {
    try {
      const known = await navigator.bluetooth.getDevices();
      const d = known.find(x => x.id === deviceId);
      if (d) {
        device = d; device.addEventListener('gattserverdisconnected', onDisconnect);
        status('Reconnecting to your band…');
        await attach();
        return;
      }
    } catch (e) {}
  }
  // Chrome needs a click to reach the band again
  chrome.notifications.create('reconnect', {
    type: 'basic', iconUrl: 'icon-128.png', title: 'Breathfold Monitor',
    message: 'Click to reconnect your heart-rate band.', buttons: [{ title: 'Reconnect' }],
  });
  status('Press Connect band to start monitoring');
}

// ---- the day's record
async function loadDay(day) {
  const key = 'd:' + day, got = await store.get(key);
  return got[key] || { day, bases: [], alerts: [], min: [], vars: [] };
}
async function saveDay(rec = today) {
  if (!rec) return;
  const { days = [] } = await store.get('days');
  const set = { ['d:' + rec.day]: rec };
  if (!days.includes(rec.day)) {
    days.push(rec.day); days.sort();
    const drop = days.splice(0, Math.max(0, days.length - KEEP_DAYS));
    if (drop.length) chrome.storage.local.remove(drop.map(d => 'd:' + d));
    set.days = days;
  }
  await store.set(set);
  histCache.set(rec.day, rec);
}
// make sure `today` is the current day; the old one is saved as it closes
async function ensureToday() {
  const day = dayKey(Date.now());
  if (today?.day === day) return today;
  if (today) await saveDay(today);
  today = await loadDay(day);
  return today;
}

async function flushMinute() {
  const m = curMin; curMin = null;
  if (!m?.n) return;
  const rec = await ensureToday();
  rec.min.push([m.k, +(m.sum / m.n).toFixed(1), m.n]);
  if (m.k % 5 === 4) {                     // variability every 5 minutes, over those 5 minutes
    const pts = since(5 * 60 * 1000);
    const v = covered(pts, 5 * 60 * 1000) ? variability(pts, baseline?.kind || 'stv') : null;
    if (v != null) rec.vars.push([m.k, +v.toFixed(2)]);
  }
  await saveDay(rec);
  renderHistory();
}

// ---- baseline and comparison
async function startBaseline(reason = 'manual') {
  baseline = { start: Date.now(), done: false, day: dayKey(Date.now()), reason };
  await store.set({ baseline });
  render();
}

// a new day starts a new baseline the first time you're actually at the computer
async function checkNewDay() {
  if (!baseline || baseline.day === dayKey(Date.now())) return;
  if (!userActive) return;
  await startBaseline('new day');
}

async function evaluate() {
  const now = Date.now();
  if (!baseline) return startBaseline('first');
  await checkNewDay();
  if (!baseline.done) {
    const pts = samples.filter(p => p.t >= baseline.start);
    if (!pts.length || now - Math.max(baseline.start, pts[0].t) < BASE_MS) return render();
    if (!covered(pts, BASE_MS)) { baseline.start = now; return render(); }   // too many gaps: start over
    const kind = pts.filter(p => p.rr.length).length > pts.length * 0.8 ? 'rmssd' : 'stv';
    Object.assign(baseline, { hr: mean(pts.map(p => p.bpm)), v: variability(pts, kind), kind, done: true, end: now });
    await store.set({ baseline });
    const rec = await ensureToday();
    rec.bases.push({ start: baseline.start, end: now, hr: +baseline.hr.toFixed(1), v: baseline.v == null ? null : +baseline.v.toFixed(2), kind, reason: baseline.reason });
    await saveDay(rec);
    renderHistory();
    return render();
  }
  const cur = current();
  render(cur);
  const { snoozeUntil: snooze = 0 } = await store.get('snoozeUntil');
  if (now < snooze || now - lastAlert < COOLDOWN || !userActive) return;   // no point notifying an empty desk
  if (!cur.hrHigh && !cur.varLow) return;
  lastAlert = now;
  const why = cur.hrHigh
    ? `Heart rate ${Math.round(cur.hr)} bpm, ${Math.round(cur.hr - baseline.hr)} above your baseline of ${Math.round(baseline.hr)}.`
    : `Variability is down to ${Math.round(cur.v / baseline.v * 100)}% of your baseline.`;
  chrome.notifications.create('suggest-' + now, {
    type: 'basic', iconUrl: 'icon-128.png', title: 'A few minutes to settle?',
    message: why + ' Breathfold can help bring it down.',
    buttons: [{ title: 'Open Breathfold' }, { title: 'Not now (1 h)' }], priority: 1,
  });
  const rec = await ensureToday();
  rec.alerts.push({ t: now, type: cur.hrHigh ? 'hr' : 'var', hr: cur.hr == null ? null : +cur.hr.toFixed(1), v: cur.v == null ? null : +cur.v.toFixed(2), why });
  await saveDay(rec);
  render(cur); renderHistory();
}

function current() {
  const hrPts = since(HR_WIN), vPts = since(VAR_WIN);
  const hr = covered(hrPts, HR_WIN) ? mean(hrPts.map(p => p.bpm)) : null;
  // a band that keeps repeating one value has no fresh data; that is not low variability
  const flat = new Set(vPts.map(p => p.bpm)).size < 3;
  const v = covered(vPts, VAR_WIN) && !flat ? variability(vPts, baseline.kind) : null;
  const hrLimit = baseline.hr + settings.hrDelta;
  const vLimit = baseline.v ? baseline.v * settings.varPct / 100 : null;
  return { hr, v, hrLimit, vLimit, hrHigh: hr != null && hr >= hrLimit, varLow: v != null && vLimit != null && baseline.v >= 0.5 && v <= vLimit };
}

// ---- view
function status(msg) { $('status').textContent = msg; }

function render(cur) {
  const live = connected && samples.length && Date.now() - samples[samples.length - 1].t < 20000;
  const paused = Date.now() < pausedUntil;
  $('connect').textContent = connected ? 'Disconnect' : 'Connect band';
  $('pause').hidden = !connected && !paused;
  $('pause').textContent = paused ? 'Resume now' : 'Release band for 2 h';
  if (!live) $('bpm').textContent = '--';

  const st = $('state');
  if (paused) { st.textContent = `released until ${clock(pausedUntil)}`; st.className = 'state idle'; }
  else if (!connected) { st.textContent = 'not connected'; st.className = 'state idle'; }
  else if (!baseline?.done) {
    const left = baseline ? Math.max(0, BASE_MS - (Date.now() - baseline.start)) : BASE_MS;
    st.textContent = `learning baseline · ${Math.ceil(left / 60000)} min`; st.className = 'state idle';
  } else if (cur && (cur.hrHigh || cur.varLow)) { st.textContent = cur.hrHigh ? 'heart rate up' : 'variability down'; st.className = 'state warn'; }
  else { st.textContent = 'within your baseline'; st.className = 'state ok'; }
  if (connected && device) status(`${device.name || 'Band'} · ${samples.some(p => p.rr.length) ? 'beat intervals' : 'heart rate only'}`);

  const kindLabel = baseline?.kind === 'rmssd' ? 'HRV (RMSSD)' : 'Variability';
  const unit = baseline?.kind === 'rmssd' ? 'ms' : 'bpm';
  $('var-k').textContent = kindLabel;
  const f = (v, u, dp = 0) => v == null ? '—' : `${v.toFixed(dp)}<small>${u}</small>`;
  const b = baseline?.done ? baseline : null;
  $('b-hr').innerHTML = f(b?.hr, 'bpm');
  $('b-var').innerHTML = f(b?.v, unit, 1);
  $('n-hr').innerHTML = f(cur?.hr, 'bpm');
  $('n-var').innerHTML = f(cur?.v, unit, 1);
  $('n-hr').classList.toggle('over', !!cur?.hrHigh);
  $('n-var').classList.toggle('over', !!cur?.varLow);
  $('l-hr').innerHTML = b ? `≥ ${f(b.hr + settings.hrDelta, 'bpm')}` : '—';
  $('l-var').innerHTML = b?.v ? `≤ ${f(b.v * settings.varPct / 100, unit, 1)}` : '—';
  $('base-note').textContent = b
    ? `Baseline from ${clock(b.start)} to ${clock(b.end)}${b.reason === 'new day' ? ', your first 5 minutes at the computer today' : b.reason === 'manual' ? ', taken when you asked' : ', the first 5 minutes after Chrome started'}.`
    : 'A baseline is taken from the first 5 minutes of data after Chrome starts, and again at your first use of each new day.';
  $('var-note').textContent = b?.kind === 'rmssd'
    ? 'Your sensor sends beat-to-beat intervals, so variability is standard short-term HRV (RMSSD).'
    : 'With a heart-rate-only band such as the Fitbit Air, true HRV isn\'t available. Variability here is how much your heart rate moves around its own 30-second average, which mostly reflects the breath-to-breath swing. It is a rough stand-in, so compare it only with itself.';

  $('o-hrDelta').textContent = `+${settings.hrDelta} bpm over baseline`;
  $('o-varPct').textContent = `below ${settings.varPct}% of baseline`;

  // toolbar badge: live bpm, ember when over the limit
  chrome.action.setBadgeText({ text: live ? String(samples[samples.length - 1].bpm) : '' });
  chrome.action.setBadgeBackgroundColor({ color: cur && (cur.hrHigh || cur.varLow) ? '#c9735f' : '#2c5a52' });
  chrome.action.setTitle({ title: live ? `Breathfold Monitor · ${samples[samples.length - 1].bpm} bpm` : 'Breathfold Monitor' });

  $('chart').innerHTML = chart(cur);
  const alerts = today?.day === dayKey(Date.now()) ? today.alerts : [];
  $('log-card').hidden = !alerts.length;
  $('log').innerHTML = alerts.slice().reverse().map(l => `<li>${clock(l.t)} · ${l.why}${l.opened ? ' · opened Breathfold' : l.snoozed ? ' · not now' : ''}</li>`).join('');
}

// last 20 minutes: 10-second means, with the baseline and the alert line
function chart(cur) {
  if (samples.length < 20) return '';
  const now = Date.now(), t0 = now - KEEP;
  const bins = new Map();
  for (const p of samples) { const k = Math.floor(p.t / 10000); const b = bins.get(k) || [0, 0]; b[0] += p.bpm; b[1]++; bins.set(k, b); }
  const pts = [...bins].map(([k, [s, n]]) => [k * 10000 + 5000, s / n]);
  const lines = baseline?.done ? [baseline.hr, baseline.hr + settings.hrDelta] : [];
  const vals = pts.map(p => p[1]).concat(lines);
  const lo = Math.floor(Math.min(...vals) - 3), hi = Math.ceil(Math.max(...vals) + 3);
  const W = 600, H = 120, pl = 30, pr = 6, pt = 8, pb = 18;
  const X = t => pl + (t - t0) / KEEP * (W - pl - pr), Y = v => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const txt = (x, y, a, s, c = 'rgba(228,236,230,0.5)') => `<text x="${x}" y="${y}" text-anchor="${a}" fill="${c}" font-size="10" font-family="ui-monospace, monospace">${s}</text>`;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const ref = baseline?.done ? `
    <line x1="${pl}" x2="${W - pr}" y1="${Y(baseline.hr)}" y2="${Y(baseline.hr)}" stroke="rgba(159,212,196,0.5)" stroke-dasharray="2 4"/>
    <line x1="${pl}" x2="${W - pr}" y1="${Y(baseline.hr + settings.hrDelta)}" y2="${Y(baseline.hr + settings.hrDelta)}" stroke="rgba(232,160,143,0.45)" stroke-dasharray="5 4"/>
    ${txt(W - pr, Y(baseline.hr) - 4, 'end', 'baseline', 'rgba(159,212,196,0.7)')}${txt(W - pr, Y(baseline.hr + settings.hrDelta) - 4, 'end', 'alert', 'rgba(232,160,143,0.7)')}` : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Heart rate over the last 20 minutes">
    ${txt(pl - 5, Y(hi) + 4, 'end', hi)}${txt(pl - 5, Y(lo) + 4, 'end', lo)}
    ${txt(pl, H - 4, 'start', '20 min ago')}${txt(W - pr, H - 4, 'end', 'now')}
    ${ref}<path d="${path}" fill="none" stroke="#e8a08f" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

// ---- controls
for (const id of ['hrDelta', 'varPct']) {
  $(id).addEventListener('input', () => { settings[id] = +$(id).value; store.set({ settings }); render(baseline?.done ? current() : null); });
}
$('connect').addEventListener('click', connect);
$('pause').addEventListener('click', async () => {
  // free the band for the phone or tablet; the monitor picks it up again afterwards
  if (Date.now() < pausedUntil) { pausedUntil = 0; stopped = false; render(); onDisconnect(); return; }
  pausedUntil = Date.now() + PAUSE;
  try { device.gatt.disconnect(); } catch (e) {}
});
$('rebase').addEventListener('click', () => startBaseline('manual'));
$('test').addEventListener('click', () => chrome.notifications.create('suggest-test', {
  type: 'basic', iconUrl: 'icon-128.png', title: 'A few minutes to settle?',
  message: 'This is a test. Clicking it opens Breathfold in Settle heart rate.',
  buttons: [{ title: 'Open Breathfold' }, { title: 'Not now (1 h)' }],
}));

// ---- start
(async () => {
  const s = await store.get(['settings', 'baseline']);
  // chrome.storage.session is cleared whenever Chrome restarts, so it tells a fresh start from a tab reload
  const { running } = await chrome.storage.session.get('running');
  await chrome.storage.session.set({ running: true });
  if (s.settings) settings = { ...settings, ...s.settings };
  $('hrDelta').value = settings.hrDelta; $('varPct').value = settings.varPct;
  today = await loadDay(dayKey(Date.now()));
  // a fresh Chrome start (or none yet) means a fresh baseline; a reload of this tab keeps the current one
  if (!running || !s.baseline) await startBaseline(running ? 'first' : 'chrome start'); else baseline = s.baseline;
  // are you at the computer? (no new-day baseline and no notifications while away or locked)
  chrome.idle.setDetectionInterval(120);
  chrome.idle.onStateChanged.addListener(st => { userActive = st === 'active'; if (userActive) checkNewDay(); });
  userActive = (await chrome.idle.queryState(120)) === 'active';
  // the background worker reports what happened to a suggestion
  chrome.runtime.onMessage.addListener(async msg => {
    if (!msg?.alert) return;
    const rec = await ensureToday(), a = rec.alerts.find(x => x.t === msg.alert);
    if (a) { a[msg.what] = true; await saveDay(rec); render(); renderHistory(); }
  });
  // don't let Chrome's memory saver put this tab to sleep
  chrome.tabs.getCurrent(tab => tab && chrome.tabs.update(tab.id, { autoDiscardable: false }));
  if (!navigator.bluetooth) { status('This Chrome has no Web Bluetooth'); $('connect').disabled = true; }
  else autoReconnect();
  render();
  initHistory();
  setInterval(() => { checkNewDay(); render(baseline?.done && connected ? current() : null); }, 15000);
})();

// ---- history dashboard: daily baselines over time, and any single day minute by minute
const histCache = new Map();
let range = 30, selDay = null;
const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const dur = mins => mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
const svgText = (x, y, a, s, c = 'rgba(228,236,230,0.5)') => `<text x="${x}" y="${y}" text-anchor="${a}" fill="${c}" font-size="10" font-family="ui-monospace, monospace">${s}</text>`;
const dayLabel = (day, long) => new Date(day + 'T12:00').toLocaleDateString([], long ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short' });

async function initHistory() {
  const { days = [] } = await store.get('days');
  if (days.length) {
    const got = await store.get(days.map(d => 'd:' + d));
    for (const k in got) histCache.set(got[k].day, got[k]);
  }
  document.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => { range = +b.dataset.range; renderHistory(); }));
  $('csv').addEventListener('click', downloadCSV);
  $('hist-rows').addEventListener('click', e => { const tr = e.target.closest('tr[data-day]'); if (tr) { selDay = tr.dataset.day; renderHistory(); } });
  renderHistory();
}

function daySummary(rec) {
  const base = rec.bases[0] || null;     // the day's first baseline is its reference
  const lim = base ? base.hr + settings.hrDelta : null;
  return {
    day: rec.day, base, med: median(rec.min.map(m => m[1])), mins: rec.min.length,
    over: lim == null ? null : rec.min.filter(m => m[1] >= lim).length,
    alerts: rec.alerts.length, opened: rec.alerts.filter(a => a.opened).length,
  };
}

function inRange() {
  if (today) histCache.set(today.day, today);
  const cutoff = dayKey(Date.now() - (range - 1) * 86400e3);
  return [...histCache.keys()].sort().filter(d => {
    const r = histCache.get(d);
    return d >= cutoff && (r.min.length || r.bases.length || r.alerts.length);
  });
}

function renderHistory() {
  if (!$('hist-rows')) return;
  const days = inRange(), sums = days.map(d => daySummary(histCache.get(d)));
  document.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('on', +b.dataset.range === range));
  $('hist-empty').hidden = days.length > 0;
  $('hist-body').hidden = !days.length;
  if (!days.length) return;

  $('trend').innerHTML = trendSVG(sums);
  const unit = k => k === 'rmssd' ? 'ms' : 'bpm';
  $('hist-rows').innerHTML = sums.slice().reverse().map(s => `<tr data-day="${s.day}" class="${s.day === selDay ? 'sel' : ''}">
    <td>${dayLabel(s.day)}</td>
    <td>${s.base ? Math.round(s.base.hr) + ' bpm' : '—'}</td>
    <td>${s.base?.v != null ? s.base.v.toFixed(1) + ' ' + unit(s.base.kind) : '—'}</td>
    <td>${s.med != null ? Math.round(s.med) + ' bpm' : '—'}</td>
    <td>${s.mins ? dur(s.mins) : '—'}</td>
    <td>${s.over == null ? '—' : s.over ? dur(s.over) : '0'}</td>
    <td>${s.alerts ? `${s.alerts}${s.opened ? ` · ${s.opened} opened` : ''}` : '—'}</td></tr>`).join('');

  if (!selDay || !histCache.has(selDay)) selDay = days[days.length - 1];
  const rec = histCache.get(selDay);
  $('day-title').textContent = dayLabel(selDay, true);
  $('day-chart').innerHTML = dayDetailSVG(rec) || '<p class="note">No heart-rate data on this day.</p>';
  document.querySelectorAll('#hist-rows tr').forEach(tr => tr.classList.toggle('sel', tr.dataset.day === selDay));
}

// each day: its baseline (glow) and its median heart rate while you were at the computer (ember)
function trendSVG(sums) {
  const W = 600, H = 150, pl = 30, pr = 8, pt = 10, pb = 20;
  const vals = sums.flatMap(s => [s.base?.hr, s.med]).filter(v => v != null);
  if (!vals.length) return '';
  const lo = Math.floor(Math.min(...vals) - 3), hi = Math.ceil(Math.max(...vals) + 3);
  const n = range, first = Date.parse(dayKey(Date.now() - (range - 1) * 86400e3) + 'T12:00');
  const X = day => pl + ((Date.parse(day + 'T12:00') - first) / 86400e3 + 0.5) / n * (W - pl - pr);
  const Y = v => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const series = (get, color, dash) => {
    const pts = sums.filter(s => get(s) != null).map(s => [X(s.day), Y(get(s))]);
    const line = pts.length > 1 ? `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')}" fill="none" stroke="${color}" stroke-width="1.3" ${dash ? 'stroke-dasharray="3 3"' : ''} opacity="0.8"/>` : '';
    return line + pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.6" fill="${color}"/>`).join('');
  };
  const ticks = [sums[0].day, sums[sums.length - 1].day].filter((d, i, a) => a.indexOf(d) === i);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily baseline and median heart rate">
    <line x1="${pl}" x2="${W - pr}" y1="${Y(hi)}" y2="${Y(hi)}" stroke="rgba(228,236,230,0.08)"/>
    <line x1="${pl}" x2="${W - pr}" y1="${Y(lo)}" y2="${Y(lo)}" stroke="rgba(228,236,230,0.08)"/>
    ${svgText(pl - 5, Y(hi) + 4, 'end', hi)}${svgText(pl - 5, Y(lo) + 4, 'end', lo)}
    ${ticks.map(d => svgText(X(d), H - 5, 'middle', dayLabel(d))).join('')}
    ${series(s => s.med, '#e8a08f', true)}${series(s => s.base?.hr, '#9fd4c4')}
  </svg>`;
}

// one day minute by minute, with its baseline, the alert line and the suggestions
function dayDetailSVG(rec) {
  if (!rec || rec.min.length < 2) return '';
  const W = 600, H = 170, pl = 30, pr = 8, pt = 14, pb = 20;
  const base = rec.bases[0];
  const t0 = rec.min[0][0], t1 = Math.max(rec.min[rec.min.length - 1][0], t0 + 30);
  const vals = rec.min.map(m => m[1]).concat(base ? [base.hr, base.hr + settings.hrDelta] : []);
  const lo = Math.floor(Math.min(...vals) - 3), hi = Math.ceil(Math.max(...vals) + 3);
  const X = k => pl + (k - t0) / (t1 - t0) * (W - pl - pr), Y = v => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  let d = '', prev = null;
  for (const [k, v] of rec.min) { d += `${prev != null && k - prev <= 3 ? 'L' : 'M'}${X(k).toFixed(1)},${Y(v).toFixed(1)}`; prev = k; }   // gaps stay gaps
  const ref = base ? `
    <line x1="${pl}" x2="${W - pr}" y1="${Y(base.hr)}" y2="${Y(base.hr)}" stroke="rgba(159,212,196,0.5)" stroke-dasharray="2 4"/>
    <line x1="${pl}" x2="${W - pr}" y1="${Y(base.hr + settings.hrDelta)}" y2="${Y(base.hr + settings.hrDelta)}" stroke="rgba(232,160,143,0.45)" stroke-dasharray="5 4"/>
    ${svgText(W - pr, Y(base.hr) - 4, 'end', 'baseline', 'rgba(159,212,196,0.7)')}${svgText(W - pr, Y(base.hr + settings.hrDelta) - 4, 'end', 'alert', 'rgba(232,160,143,0.7)')}` : '';
  const marks = rec.alerts.map(a => {
    const x = X(a.t / 60000);
    return `<path d="M${(x - 4).toFixed(1)},${pt - 10} L${(x + 4).toFixed(1)},${pt - 10} L${x.toFixed(1)},${pt - 3} Z" fill="${a.opened ? '#e8a08f' : 'none'}" stroke="#e8a08f"><title>${clock(a.t)} · ${a.why}</title></path>`;
  }).join('');
  const hourTicks = [];
  for (let h = Math.ceil(t0 / 60) * 60; h <= t1; h += (t1 - t0 > 360 ? 120 : 60)) hourTicks.push(svgText(X(h), H - 5, 'middle', clock(h * 60000)));
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Heart rate through the day">
    ${svgText(pl - 5, Y(hi) + 4, 'end', hi)}${svgText(pl - 5, Y(lo) + 4, 'end', lo)}
    ${hourTicks.join('')}${ref}${marks}
    <path d="${d}" fill="none" stroke="#e8a08f" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
}

// every minute in the chosen range, for a spreadsheet
function downloadCSV() {
  const rows = [['day', 'time', 'heart_rate', 'readings', 'baseline_hr', 'baseline_variability', 'variability_5min', 'suggestion']];
  for (const day of inRange()) {
    const rec = histCache.get(day), base = rec.bases[0];
    const vars = new Map(rec.vars), alerts = new Map(rec.alerts.map(a => [Math.floor(a.t / 60000), a]));
    for (const [k, bpm, n] of rec.min) {
      const t = new Date(k * 60000), a = alerts.get(k);
      rows.push([day, t.toTimeString().slice(0, 5), bpm, n, base?.hr ?? '', base?.v ?? '', vars.get(k) ?? '',
        a ? `${a.type}${a.opened ? ' (opened)' : a.snoozed ? ' (not now)' : ''}` : '']);
    }
  }
  const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `breathfold-monitor-${dayKey(Date.now())}.csv` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
