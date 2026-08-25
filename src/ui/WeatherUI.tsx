// Погода в интерфейсе: значок «15°» на карте и предупреждения по пути.

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { WeatherAt, WeatherNow } from '../weather';
import { fmtClock } from '../online';
import { Icon, type IconName } from './Icon';
import { C, shadow, themed, sz } from './theme';

/** Значок погоды на карте (как у Яндекса). Нажатие — подробнее. */
export function WeatherChip({ now, onPress, style }: { now: WeatherNow | null; onPress?: () => void; style?: object }) {
  if (!now || !Number.isFinite(now.temp)) return null;
  return (
    <Pressable onPress={onPress} style={[s.chip, style]}>
      <Icon name={now.icon as IconName} size={22} color={iconColor(now.icon)} />
      <Text style={s.chipText}>{now.temp > 0 ? '+' : ''}{Math.round(now.temp)}°</Text>
    </Pressable>
  );
}

/** Строка про погоду в пути: «Ялта к 15:40 · +18° ясно» или предупреждение. */
export function WeatherRoute({ items, compact }: { items: WeatherAt[] | null; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  const dest = items[items.length - 1];
  const bad = items.filter((w) => w.danger.length);
  const main = bad[0] ?? dest;
  const warn = bad.length > 0;
  return (
    <Pressable onPress={() => setOpen(!open)} style={[s.route, warn && s.routeWarn, compact && { marginTop: 0 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Icon name={(warn ? 'alert-outline' : main.icon) as IconName} size={20} color={warn ? C.red : iconColor(main.icon)} style={{ marginRight: 8 }} />
        <Text style={[s.routeText, warn && { color: C.redText }]} numberOfLines={open ? 3 : 1}>
          {line(main)}{extra(main)}
        </Text>
        {items.length > 1 && <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={C.sub} />}
      </View>
      {open && items.filter((w) => w !== main).map((w, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
          <Icon name={w.icon as IconName} size={18} color={iconColor(w.icon)} style={{ marginRight: 8 }} />
          <Text style={s.routeSub}>{line(w)}{extra(w)}</Text>
        </View>
      ))}
    </Pressable>
  );
}

const line = (w: WeatherAt) => `${w.name} к ${fmtClock(w.atMs)} · ${w.temp > 0 ? '+' : ''}${Math.round(w.temp)}°, ${w.text}${w.precipProb >= 40 && !/дожд|ливен|снег|морос|гроз/.test(w.text) ? `, осадки ${w.precipProb}%` : ''}`;

/** Опасности, которых ещё нет в описании («гроза — гроза» не пишем). */
const extra = (w: WeatherAt) => { const d = w.danger.filter((x) => !x.startsWith(w.text)); return d.length ? ` — ${d.join(', ')}` : ''; };

function iconColor(icon: string): string {
  if (/sunny/.test(icon)) return '#f59f00';
  if (/lightning|hail|alert/.test(icon)) return '#e03131';
  if (/snow/.test(icon)) return '#4dabf7';
  if (/rain|pouring/.test(icon)) return '#339af0';
  return C.sub;
}

const s = themed(() => ({
  chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: sz(16), paddingHorizontal: sz(12), paddingVertical: sz(8), ...shadow },
  chipText: { fontSize: sz(17), fontWeight: '700', color: C.text, marginLeft: sz(6) },
  route: { backgroundColor: C.chip, borderRadius: sz(14), paddingHorizontal: sz(12), paddingVertical: sz(9), marginTop: sz(10) },
  routeWarn: { backgroundColor: C.redSoft },
  routeText: { flex: 1, fontSize: sz(13), color: C.text, fontWeight: '600' },
  routeSub: { flex: 1, fontSize: sz(13), color: C.sub },
}));
