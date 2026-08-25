// Карточка «Объезд пробки»: на сколько быстрее, насколько длиннее, по какой дороге.

import { Pressable, Text, View } from 'react-native';
import type { DetourOffer } from '../detour';
import { fmtDistance, fmtDuration } from '../online';
import { Icon } from './Icon';
import { C, shadow, themed, sz } from './theme';

export function DetourCard({ offers, onTake, onSkip }: { offers: DetourOffer[]; onTake: (o: DetourOffer) => void; onSkip: (o: DetourOffer) => void }) {
  if (!offers.length) return null;
  return (
    <View style={s.wrap}>
      {offers.map((o, i) => (
        <View key={i} style={[s.card, i > 0 && { marginTop: 8 }]}>
          <View style={s.badge}><Icon name="call-split" size={22} color="#fff" /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>{i === 0 ? 'Объезд пробки' : 'Ещё объезд'} · быстрее на {fmtDuration(o.savingS)}</Text>
            <Text style={s.sub} numberOfLines={1}>
              {o.extraM > 150 ? `+${fmtDistance(o.extraM)} пути` : o.extraM < -150 ? `короче на ${fmtDistance(-o.extraM)}` : 'та же длина'}
              {o.via ? ` · через ${o.via}` : ''}
            </Text>
          </View>
          <Pressable onPress={() => onTake(o)} style={({ pressed }) => [s.go, pressed && { opacity: 0.8 }]}><Text style={s.goText}>Поехать</Text></Pressable>
          <Pressable onPress={() => onSkip(o)} hitSlop={10} style={{ padding: 6, marginLeft: 2 }}><Icon name="close" size={20} color={C.sub} /></Pressable>
        </View>
      ))}
    </View>
  );
}

const s = themed(() => ({
  wrap: { marginBottom: sz(8) },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: sz(18), padding: sz(10), borderWidth: 2, borderColor: C.green, ...shadow },
  badge: { width: sz(40), height: sz(40), borderRadius: sz(12), backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', marginRight: sz(10) },
  title: { fontSize: sz(15), fontWeight: '700', color: C.text },
  sub: { fontSize: sz(12), color: C.sub, marginTop: 2 },
  go: { backgroundColor: C.green, borderRadius: sz(12), paddingHorizontal: sz(14), paddingVertical: sz(9), marginLeft: sz(8) },
  goText: { color: '#fff', fontWeight: '800', fontSize: sz(14) },
}));
