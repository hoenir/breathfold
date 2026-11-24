// Breathfold Monitor: holds the heart-rate band, learns a baseline from the first 5 minutes after Chrome starts,
// then suggests a Breathfold session when heart rate rises or variability drops past the chosen limits.
const $ = id => document.getElementById(id);
const BASE_MS = 5 * 60 * 1000;       // baseline length
const HR_WIN = 2 * 60 * 1000;        // "now" heart rate: mean of the last 2 minutes
const VAR_WIN = 3 * 60 * 1000;       // "now" variability: the last 3 minutes
const KEEP = 20 * 60 * 1000;
const COOLDOWN = 30 * 60 * 1000;     // at most one suggestion per half hour
const PAUSE = 2 * 60 * 60 * 1000;

const store = {
  get: keys => chrome.storage.local.get(keys),
  set: obj => chrome.storage.local.set(obj),
};

let settings = { hrDelta: 10, varPct: 60 };
let baseline = null;                 // { start, hr, v, kind: 'rmssd' | 'stv', done }
let samples = [];                    // { t, bpm, rr: [] }
let device = null, connected = false, attaching = false, stopped = false, lastEval = 0, lastAlert = 0, snoozeUntil = 0, pausedUntil = 0;
let log = [];

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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

// ---- baseline and comparison
async function startBaseline() {
  baseline = { start: Date.now(), done: false };
  await store.set({ baseline });
  render();
}

async function evaluate() {
  const now = Date.now();
  if (!baseline) return startBaseline();
  if (!baseline.done) {
    const pts = samples.filter(p => p.t >= baseline.start);
    if (!pts.length || now - Math.max(baseline.start, pts[0].t) < BASE_MS) return render();
    if (!covered(pts, BASE_MS)) { baseline.start = now; return render(); }   // too many gaps: start over
    const kind = pts.filter(p => p.rr.length).length > pts.length * 0.8 ? 'rmssd' : 'stv';
    Object.assign(baseline, { hr: mean(pts.map(p => p.bpm)), v: variability(pts, kind), kind, done: true, end: now });
    await store.set({ baseline });
    return render();
  }
  const cur = current();
  render(cur);
  const { snoozeUntil: snooze = 0 } = await store.get('snoozeUntil');
  if (now < snooze || now - lastAlert < COOLDOWN) return;
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
  log.unshift({ t: now, why });
  const day = new Date().toDateString();
  await store.set({ log: { day, items: log.slice(0, 20) } });
  render(cur);
}

function current() {
  const hrPts = since(HR_WIN), vPts = since(VAR_WIN);
  const hr = covered(hrPts, HR_WIN) ? mean(hrPts.map(p => p.bpm)) : null;
  const v = covered(vPts, VAR_WIN) ? variability(vPts, baseline.kind) : null;
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
    ? `Baseline from ${clock(b.start)} to ${clock(b.end)}, the first 5 minutes of data after Chrome started.`
    : 'The baseline is taken from the first 5 minutes of data after Chrome starts.';
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
  $('log-card').hidden = !log.length;
  $('log').innerHTML = log.map(l => `<li>${clock(l.t)} · ${l.why}</li>`).join('');
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
$('rebase').addEventListener('click', startBaseline);
$('test').addEventListener('click', () => chrome.notifications.create('suggest-test', {
  type: 'basic', iconUrl: 'icon-128.png', title: 'A few minutes to settle?',
  message: 'This is a test. Clicking it opens Breathfold in Settle heart rate.',
  buttons: [{ title: 'Open Breathfold' }, { title: 'Not now (1 h)' }],
}));

// ---- start
(async () => {
  const s = await store.get(['settings', 'baseline', 'log']);
  // chrome.storage.session is cleared whenever Chrome restarts, so it tells a fresh start from a tab reload
  const { running } = await chrome.storage.session.get('running');
  await chrome.storage.session.set({ running: true });
  if (s.settings) settings = { ...settings, ...s.settings };
  $('hrDelta').value = settings.hrDelta; $('varPct').value = settings.varPct;
  if (s.log?.day === new Date().toDateString()) log = s.log.items;
  // a fresh Chrome start (or none yet) means a fresh baseline; a reload of this tab keeps the current one
  if (!running || !s.baseline) await startBaseline(); else baseline = s.baseline;
  // don't let Chrome's memory saver put this tab to sleep
  chrome.tabs.getCurrent(tab => tab && chrome.tabs.update(tab.id, { autoDiscardable: false }));
  if (!navigator.bluetooth) { status('This Chrome has no Web Bluetooth'); $('connect').disabled = true; }
  else autoReconnect();
  render();
  setInterval(() => render(baseline?.done && connected ? current() : null), 15000);
})();
