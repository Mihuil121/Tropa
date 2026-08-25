import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { C, shadow, themed, sz } from './theme';
import { Icon, type IconName } from './Icon';

export function Chip({ text, color, onPress }: { text: string; color: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.chip]}>
      <View style={[s.dot, { backgroundColor: color }]} />
      <Text style={s.chipText} numberOfLines={1}>{text}</Text>
    </Pressable>
  );
}

export function Button({ text, onPress, kind = 'primary', style, small }: { text: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; style?: ViewStyle; small?: boolean }) {
  const bg = kind === 'primary' ? C.accent : kind === 'danger' ? C.redSoft : C.chip;
  const fg = kind === 'primary' ? C.accentText : kind === 'danger' ? C.red : C.text;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.btn, small && s.btnSmall, { backgroundColor: bg }, pressed && { opacity: 0.7 }, style]}>
      <Text style={[s.btnText, small && { fontSize: 14 }, { color: fg }]}>{text}</Text>
    </Pressable>
  );
}

/**
 * Знак «ограничение скорости» (красный круг) и под ним ваша скорость — как в навигаторах.
 * Превышение: скорость краснеет, знак мигает рамкой.
 */
export function SpeedSign({ limit, speed, style }: { limit: number | null; speed: number | null; style?: ViewStyle }) {
  if (limit == null && speed == null) return null;
  const over = limit != null && speed != null && speed > limit + 3;
  return (
    <View style={[{ alignItems: 'center' }, style]}>
      {limit != null && (
        <View style={[s.sign, over && { 
          borderColor: '#ff1f1f', 
          transform: [{ scale: 1.08 }],
          shadowColor: '#ff1f1f',
          shadowOpacity: 0.5,
          shadowRadius: 12,
        }]}>
          <Text style={[s.signText, limit >= 100 && { fontSize: 22 }]}>{limit}</Text>
        </View>
      )}
      {speed != null && (
        <View style={[s.speed, over && { 
          backgroundColor: '#ff3b30',
          shadowColor: '#ff3b30',
          shadowOpacity: 0.4,
          shadowRadius: 8,
        }]}>
          <Text style={[s.speedText, over && { color: '#fff' }]}>{Math.round(speed)}</Text>
          <Text style={[s.speedUnit, over && { color: '#fff' }]}>км/ч</Text>
        </View>
      )}
    </View>
  );
}

/** Заголовок раздела с иконкой. */
export function Section({ icon, title, first }: { icon: IconName; title: string; first?: boolean }) {
  return (
    <View style={[s.section, !first && { marginTop: 20 }]}>
      <View style={s.sectionIcon}><Icon name={icon} size={20} color={C.blue} /></View>
      <Text style={s.sectionText}>{title}</Text>
    </View>
  );
}

/** Вертикальная группа кнопок на карте в одной карточке. */
export function MapButtonGroup({ items }: { items: { icon: IconName; onPress: () => void; active?: boolean }[] }) {
  return (
    <View style={s.group}>
      {items.map((it, i) => (
        <Pressable key={i} onPress={it.onPress} style={({ pressed }) => [s.groupBtn, i > 0 && s.groupSep, pressed && { opacity: 0.6 }]}>
          <Icon name={it.icon} size={sz(24)} color={it.active ? C.blue : C.text} />
        </Pressable>
      ))}
    </View>
  );
}

/** Круглая кнопка на карте (как «моё местоположение» в навигаторах). */
export function MapButton({ icon, onPress, active }: { icon: IconName; onPress: () => void; active?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.mapBtn, active && { backgroundColor: C.blue }, pressed && { opacity: 0.7 }]}>
      <Icon name={icon} size={sz(26)} color={active ? '#fff' : C.blue} />
    </Pressable>
  );
}

export function Row({ title, sub, right, onPress }: { title: string; sub?: string; right?: ReactNode; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed && onPress && { backgroundColor: C.chip }]}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
        {!!sub && <Text style={s.rowSub} numberOfLines={2}>{sub}</Text>}
      </View>
      {right}
    </Pressable>
  );
}

const s = themed(() => ({
  chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.chip, borderRadius: sz(14), paddingHorizontal: sz(10), paddingVertical: sz(5), marginRight: sz(6), marginTop: sz(6) },
  dot: { width: sz(8), height: sz(8), borderRadius: sz(4), marginRight: sz(6) },
  chipText: { fontSize: sz(13), color: C.text, maxWidth: sz(220) },
  btn: { borderRadius: sz(14), paddingVertical: sz(14), alignItems: 'center', justifyContent: 'center', flex: 1 },
  btnSmall: { paddingVertical: sz(10) },
  btnText: { fontSize: sz(16), fontWeight: '700' },
  mapBtn: { width: sz(56), height: sz(56), borderRadius: sz(28), backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', marginTop: sz(12), ...shadow },
  mapBtnText: { fontSize: sz(18), color: C.text, fontWeight: '600' },
  sign: { 
    width: sz(62), 
    height: sz(62), 
    borderRadius: sz(31), 
    backgroundColor: C.signBg, 
    borderWidth: 6, 
    borderColor: '#e03131', 
    alignItems: 'center', 
    justifyContent: 'center', 
    ...shadow,
    shadowColor: '#e03131',
    shadowOpacity: 0.25,
    elevation: 8,
  },
  signText: { fontSize: sz(25), fontWeight: '800', color: C.signText },
  speed: { 
    marginTop: sz(6), 
    backgroundColor: C.card, 
    borderRadius: sz(16), 
    paddingHorizontal: sz(12), 
    paddingVertical: sz(6), 
    alignItems: 'center', 
    minWidth: sz(62), 
    ...shadow,
    elevation: 6,
  },
  speedText: { fontSize: sz(22), fontWeight: '800', color: C.text, lineHeight: sz(26) },
  speedUnit: { fontSize: sz(10), color: C.sub, marginTop: -2 },
  section: { flexDirection: 'row', alignItems: 'center' },
  sectionIcon: { width: sz(34), height: sz(34), borderRadius: sz(10), backgroundColor: C.blueSoft, alignItems: 'center', justifyContent: 'center', marginRight: sz(10) },
  sectionText: { fontSize: sz(17), fontWeight: '700', color: C.text },
  group: { backgroundColor: C.card, borderRadius: sz(18), overflow: 'hidden', ...shadow },
  groupBtn: { width: sz(52), height: sz(52), alignItems: 'center', justifyContent: 'center' },
  groupSep: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  groupText: { fontSize: sz(17), fontWeight: '700', color: C.text },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: sz(12), paddingHorizontal: sz(4), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  rowTitle: { fontSize: sz(16), color: C.text, fontWeight: '600' },
  rowSub: { fontSize: sz(13), color: C.sub, marginTop: 2 },
}));
