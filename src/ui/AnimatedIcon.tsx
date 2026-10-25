// Анимированные иконки: Lottie-файлы из react-useanimations (только JSON из lib/, сам компонент пакета не используется).
// Цвет меняем прямо в JSON: перекрашиваем тёмные заливки и обводки. В лёгком режиме рисуем обычную иконку.

import { useEffect, useMemo, useRef } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import LottieView from 'lottie-react-native';
import download from 'react-useanimations/lib/download';
import trash from 'react-useanimations/lib/trash';
import loading from 'react-useanimations/lib/loading';
import alertTriangle from 'react-useanimations/lib/alertTriangle';
import checkmark from 'react-useanimations/lib/checkmark';
import { Icon, type IconName } from './Icon';
import { getLite } from './liteFlag';

export type AnimName = 'download' | 'trash' | 'loading' | 'alertTriangle' | 'checkmark';

const DATA: Record<AnimName, { animationData: object }> = { download, trash, loading, alertTriangle, checkmark };
const FALLBACK: Record<AnimName, IconName> = { download: 'download', trash: 'delete-outline', loading: 'loading', alertTriangle: 'alert-outline', checkmark: 'check' };

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  return [parseInt(f.slice(0, 2), 16) / 255, parseInt(f.slice(2, 4), 16) / 255, parseInt(f.slice(4, 6), 16) / 255];
}

// Обход JSON: у заливок (fl) и обводок (st) меняем цвет. Белые (служебные) не трогаем: перекрашиваем только тёмные.
function tint(node: any, rgb: number[]): void {
  if (Array.isArray(node)) { node.forEach((n) => tint(n, rgb)); return; }
  if (!node || typeof node !== 'object') return;
  if ((node.ty === 'fl' || node.ty === 'st') && node.c && Array.isArray(node.c.k)) {
    const k = node.c.k;
    if (typeof k[0] === 'number') {
      if (k[0] + k[1] + k[2] < 0.6) { k[0] = rgb[0]; k[1] = rgb[1]; k[2] = rgb[2]; }
    } else {
      for (const kf of k) for (const key of ['s', 'e']) if (Array.isArray(kf[key])) { kf[key][0] = rgb[0]; kf[key][1] = rgb[1]; kf[key][2] = rgb[2]; }
    }
  }
  for (const key of Object.keys(node)) tint(node[key], rgb);
}

const cache = new globalThis.Map<string, object>();
function tinted(name: AnimName, color: string): object {
  const key = `${name}|${color}`;
  let r = cache.get(key);
  if (r) return r;
  const created = JSON.parse(JSON.stringify(DATA[name].animationData)) as object;
  tint(created, hexToRgb(color));
  cache.set(key, created);
  return created;
}

/** playKey: увеличьте число, чтобы проиграть анимацию ещё раз (например, при нажатии). */
export function AnimatedIcon({ name, size = 24, color = '#1d2129', loop = false, autoPlay = true, playKey = 0, style }: {
  name: AnimName; size?: number; color?: string; loop?: boolean; autoPlay?: boolean; playKey?: number; style?: StyleProp<ViewStyle>;
}) {
  const ref = useRef<LottieView>(null);
  const lite = getLite();
  const source = useMemo(() => tinted(name, color), [name, color]);
  useEffect(() => {
    if (!lite && playKey > 0) { ref.current?.reset(); ref.current?.play(); }
  }, [playKey, lite]);
  if (lite) return <Icon name={FALLBACK[name]} size={size} color={color} style={style as any} />;
  return <LottieView ref={ref} source={source as any} autoPlay={autoPlay} loop={loop} style={[{ width: size, height: size }, style]} />;
}
