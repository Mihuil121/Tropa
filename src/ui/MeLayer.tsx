// Значок «я» на карте — отдельным компонентом.
//
// Раньше плавное движение стрелки (20 кадров в секунду) жило в App: каждый кадр
// перерисовывался весь экран со всеми панелями и слоями карты — на старых телефонах это
// главный источник тормозов. Теперь 20 раз в секунду обновляется только этот слой.
// В лёгком режиме — без анимации: позиция меняется раз в секунду.

import { memo, useMemo } from 'react';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import type { NavState } from '../core/engine';
import { useSmoothPose } from './motion';
import { C } from './theme';
import { dlogEvery } from '../debugLog';

function offset(lat: number, lon: number, dx: number, dy: number): [number, number] {
  return [lon + dx / (111320 * Math.cos((lat * Math.PI) / 180)), lat + dy / 111320];
}
function circle(lat: number, lon: number, r: number, steps: number): GeoJSON.Feature {
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) { const a = (i / steps) * 2 * Math.PI; ring.push(offset(lat, lon, r * Math.sin(a), r * Math.cos(a))); }
  return { type: 'Feature', properties: { kind: 'acc' }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

type Props = { nav: NavState | null; smooth: boolean };

function MeLayerImpl({ nav, smooth }: Props) {
  const target = nav?.ready ? { lat: nav.lat, lon: nav.lon, heading: nav.headingDeg } : null;
  const animated = useSmoothPose(smooth ? target : null);
  const pose = smooth ? animated : target;
  const sigma = nav?.sigma ?? 0;
  const icon = nav?.ready ? `${nav.walking || nav.speedKmh < 3 ? 'me-dot' : 'me-arrow'}${nav.gps !== 'ok' ? '-warn' : ''}` : '';
  const geo = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!pose) return { type: 'FeatureCollection', features: [] };
    const f: GeoJSON.Feature[] = [];
    if (sigma > 15 && sigma < 20000) f.push(circle(pose.lat, pose.lon, 2 * sigma, smooth ? 48 : 24));
    f.push({ type: 'Feature', properties: { kind: 'me', icon, rot: pose.heading }, geometry: { type: 'Point', coordinates: [pose.lon, pose.lat] } });
    return { type: 'FeatureCollection', features: f };
  }, [pose?.lat, pose?.lon, pose?.heading, Math.round(sigma), icon, smooth]);

  if (pose) dlogEvery('я-на-карте', 30, `значок «я»: ${pose.lat.toFixed(5)},${pose.lon.toFixed(5)} ${icon} ±${Math.round(sigma)} м`);
  return (
    <GeoJSONSource id="me" data={geo}>
      <Layer type="fill" id="me-acc" filter={['==', ['get', 'kind'], 'acc']} paint={{ 'fill-color': C.blue, 'fill-opacity': 0.12, 'fill-outline-color': C.blue }} />
      <Layer type="symbol" id="me-icon" filter={['==', ['get', 'kind'], 'me']}
        layout={{
          'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'rot'],
          'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.3, 14, 0.4, 18, 0.48],
          'icon-allow-overlap': true, 'icon-ignore-placement': true,
        }} />
    </GeoJSONSource>
  );
}

export const MeLayer = memo(MeLayerImpl);
