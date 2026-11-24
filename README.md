# Breathfold

A full-screen breathing exercise. As you breathe in, a line unfolds into nested polygons (triangle to octagon) or folds into a star, and folds back as you breathe out. Choose from research-backed patterns (coherent breathing, long exhale, cyclic sighing, box, 4·7·8) or tune inhale, hold, exhale and rest yourself.

Live app: https://sandervandecruys.be/breathfold/

## Heart rate

Connect any sensor that broadcasts the standard Bluetooth Heart Rate Profile (Fitbit Air via Google Health → Connections → Share heart rate, chest straps, many watches). Needs Chrome or Edge on Android, Windows or Mac; iPhone browsers have no Web Bluetooth.

- **Breath swing**: how far heart rate rises and falls within each breath. Works with bpm-only bands such as the Fitbit Air.
- **Before & after**: resting heart rate measured for 1–2 minutes before and after the session.
- **HRV (RMSSD)**: only with sensors that send beat-to-beat intervals, such as a Polar H10.

## Settle heart rate

Pick **Settle heart rate** in the pattern list (heart rate must be connected). It's for bringing a raised heart rate down, for example after activity.

1. **Your own pace.** Breathe as you are and tap the screen as each breath comes in (7 taps). The pacer starts at exactly that rate, with a slightly longer out-breath.
2. **Gentle slowing.** After a first settling-in minute, every 6 breaths the app compares heart rate with the 6 breaths before. If it held steady or fell, the pace slows by 4%. The extra time goes to the out-breath first, until the out-breath is twice the in-breath. Never slower than 6 breaths a minute, and no holds.
3. **Backing off.** If heart rate rises 3 bpm or more, the pace goes back one step and holds for a while. If the breath swing jumped at the same time (a sign of deeper breathing), it first asks for *smaller breaths*. The **Easier** button backs off by hand.
4. **Small breaths.** The figure only opens partway, and the cues say "soft in" and "slowly out".

The band's delay is allowed for. After each session the app measures how long heart rate trails the breath for that device, and uses that delay to judge each group of breaths.

**Just rest** is the comparison: the same length, no pacer, only the mountain scene. Once there are a few of each, the results card compares the typical heart-rate drop over the first 5 minutes.

## Install on a phone

- **Android (Chrome)**: open the live app, then menu → *Install app* (or *Add to Home screen*).
- **iPhone (Safari)**: Share → *Add to Home Screen*. Breathing works; heart rate does not.

## Run locally

```bash
python -m http.server 8765 --directory app
```

Open http://localhost:8765. Add `?demo=air` to simulate a bpm-only band.

`breathe.html` is the original single-file prototype.

## Breathfold Monitor (Chrome extension)

`extension/` watches your heart rate in the background while you use the computer, even when Breathfold itself is closed. It stays quiet until something drifts, then suggests a session.

- **Baseline**: the first 5 minutes of heart-rate data after Chrome starts, and again the first time you're at the computer each new day (days start at 4 am; Chrome's idle detection means a computer left on overnight doesn't take one while you're away). Or press *New baseline from now*.
- **Alerts**: a notification when the 2-minute average heart rate is 10 bpm or more above baseline, or when 3-minute variability falls below 60% of baseline. Both limits are adjustable. At most one suggestion every 30 minutes; *Not now* silences it for an hour. Clicking opens Breathfold in Settle heart rate.
- **Variability**: RMSSD with sensors that send beat intervals. With a bpm-only band like the Fitbit Air, it is how much heart rate moves around its own 30-second average, a rough stand-in for HRV.
- The live bpm shows on the toolbar icon. No notifications while you're away or the screen is locked.
- **History** (in the same tab): each day's baseline and median heart rate over 14, 30 or 90 days; a table with variability, time monitored, time above the alert line and suggestions (and whether you opened Breathfold); and any day minute by minute. *Download CSV* exports the minutes. Data stays in Chrome on this computer, kept for 180 days.

Chrome extensions can't use Bluetooth from their background worker, so the band is held by a small monitor page that opens as a pinned tab. Keep that tab open. The Fitbit Air serves one device at a time, so press *Release band for 2 h* before using Breathfold on your phone or tablet.

**Install**: open `chrome://extensions`, switch on *Developer mode*, click *Load unpacked* and choose the `extension` folder. In the monitor tab, press *Connect band* and pick your band.
