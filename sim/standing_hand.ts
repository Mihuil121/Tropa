import { NavEngine } from '../src/core/engine.ts';
export function run(route: boolean) {
  const e = new NavEngine(); e.setTravelMode('car');
  if (route) e.setRoute([{ lat: 44.5973, lon: 33.4945 }, { lat: 44.5980, lon: 33.4900 }]);
  const T0 = 1_790_000_000, wifi = [{ bssid: 'a1', dbm: -70 }, { bssid: 'b2', dbm: -75 }];
  let maxV = 0, base: any = null, drift = 0;
  for (let s = 0; s <= 60; s++) {
    const t = T0 + s;
    e.onGnssSignal(t, { used: 12, cn0Top: 45, cn0Std: 0.5, agc: null });
    e.onMotion(t, 0.65, 0.38, 3.5);
    if (s % 5 === 0) e.onCells(t, [], wifi);
    if (s === 5) e.onNetworkFix(t, { lat: 44.59716, lon: 33.49562, accuracy: 95 }, 'сети');
    if (s === 30) e.onNetworkFix(t, { lat: 44.59785, lon: 33.49304, accuracy: 90 }, 'сети');
    if (s >= 5) e.onGps({ t, lat: 44.9879 + s * 1e-5, lon: 34.1027, accuracy: 5, speed: 38.9, bearing: 209 });
    const st = e.getState(t);
    if (s === 30) base = st;
    if (base && s >= 30) { drift = Math.max(drift, Math.hypot((st.lat - base.lat) * 111320, (st.lon - base.lon) * 79500)); maxV = Math.max(maxV, st.speedKmh); }
  }
  return { route, maxKmh: +maxV.toFixed(1), driftM: +drift.toFixed(0) };
}
if (process.argv[1]?.endsWith('standing_hand.ts')) console.log(run(false), run(true));
