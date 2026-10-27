// Стоим на месте, GPS подменён («летит» со скоростью 140 км/ч за 68 км), сеть даёт ±90 м.
import { NavEngine } from '../src/core/engine.ts';
const TRUE = { lat: 44.5970, lon: 33.4955 };
const M = 1 / 111320;
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
export function run(verbose = true) {
  const eng = new NavEngine();
  const t0 = 1_800_000_000;
  let maxErr = 0, maxV = 0;
  const wifiAll = Array.from({ length: 16 }, (_, i) => ({ bssid: `aa:bb:cc:00:00:${i.toString(16).padStart(2, '0')}`, dbm: -60 - i * 2.5 }));
  eng.onNetworkFix(t0 + 1, { lat: TRUE.lat + 0.07, lon: TRUE.lon - 0.03, accuracy: 12000 }); // грубая вышка в 8 км
  let big = true;
  for (let s = 2; s <= 180; s++) {
    const t = t0 + s;
    const hand = s > 70 && s < 140; // взяли телефон в руку
    for (let k = 0; k < 5; k++) eng.onGyro(t - 0.8 + k * 0.2, rnd() * 0.01 + (hand ? rnd() * 0.15 : 0));
    eng.onMotion(t, hand ? 0.65 : 0.1, hand ? 0.45 : 0.06, hand ? 2 : 0.2);
    // GPS подмена: точка далеко, v=38.9 м/с
    eng.onGps({ t, lat: 44.985 + s * 1e-4, lon: 34.105, accuracy: 4, speed: 38.9, bearing: 214 });
    if (s === 12) { eng.onNetworkFix(t, { lat: TRUE.lat + 40 * M, lon: TRUE.lon, accuracy: 98 }); }
    if (s % 8 === 0 && s > 12) eng.onNetworkFix(t, { lat: TRUE.lat + rnd() * 70 * M, lon: TRUE.lon + rnd() * 70 * M / 0.71, accuracy: 60 + Math.abs(rnd()) * 60 });
    if (s % 5 === 0) {
      // Wi‑Fi: набор мерцает у порога видимости
      const flick = s > 70 && s < 140 ? 0.55 : 0; const vis = wifiAll.filter((w, i) => (i < 4 || Math.abs(rnd()) > flick) && (s <= 70 || s >= 140 || Math.abs(rnd()) > 0.2));
      eng.onCells(t, [], vis);
    }
    if (s % 5 === 0) {
      const st = eng.getState(t);
      const err = Math.hypot((st.lat - TRUE.lat) / M, (st.lon - TRUE.lon) / M * 0.71);
      maxErr = Math.max(maxErr, err); maxV = Math.max(maxV, st.speedKmh / 3.6);
      if (verbose) console.log(String(s).padStart(3), 'err', err.toFixed(0).padStart(4), 'м  v', ((st.speedKmh / 3.6) * 3.6).toFixed(1).padStart(5), 'км/ч  σ', Math.round(st.sigma), ' ', st.gps, '|', st.mode);
    }
  }
  return { maxErr, maxV };
}
if (process.argv[1]?.endsWith('standing_spoof.ts')) console.log(run());
