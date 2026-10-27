// Стоим на месте в Севастополе, GPS подменён (Симферополь, 41 м/с). Стрелка не должна уезжать.
import { NavEngine } from '../src/core/engine.ts';
const e = new NavEngine();
e.setTravelMode('car');
const T0 = 1_790_000_000;
const net = { lat: 44.5981, lon: 33.4956, accuracy: 2100 };
const wifi = ['a1','b2','c3','d4','e5','f6','07','18'].map((b) => ({ bssid: b, dbm: -70 }));
let maxSpeed = 0, maxDrift = 0, base: any = null;
for (let s = 0; s < 120; s++) {
  const t = T0 + s;
  e.onGnssSignal(t, { used: s < 20 ? 0 : 12, cn0Top: s < 20 ? 0 : 39, cn0Std: s < 20 ? 0 : 0.8, agc: null });
  e.onMotion(t, 0.5, 0.45, s % 3 ? 5 : 1);   // телефон в руке, лёгкая тряска
  if (s === 0) e.onGps({ t, lat: 44.99999, lon: 34.10905, accuracy: 10, speed: 41.4, bearing: 106 }); // кэш
  if (s >= 3 && s % 5 === 3) e.onNetworkFix(t, net, 'сети');
  if (s % 5 === 0) e.onCells(t, [], wifi);
  if (s > 5 && s % 2 === 0) e.onGps({ t, lat: 44.9879 + s * 1e-5, lon: 34.1027, accuracy: 5, speed: 38.9, bearing: 209 });
  const st = e.getState(t);
  if (st.ready) {
    if (!base && s > 30) base = st;
    if (base) maxDrift = Math.max(maxDrift, Math.hypot((st.lat - base.lat) * 111320, (st.lon - base.lon) * 79500));
    if (s > 30) maxSpeed = Math.max(maxSpeed, st.speedKmh);
  }
  if (s % 20 === 0) console.log(s, st.ready, st.lat.toFixed(5), st.lon.toFixed(5), st.speedKmh.toFixed(1), st.gps, st.mode);
}
console.log('макс. скорость после 30 с:', maxSpeed.toFixed(1), 'км/ч; макс. уход от точки:', maxDrift.toFixed(0), 'м');
