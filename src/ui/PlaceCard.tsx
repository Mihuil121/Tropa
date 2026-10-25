// Карточка выбранного места на карте (долгое нажатие) и плашка остановок для панели ведения.

import { Pressable, Text, View } from 'react-native';
import type { Place, Stop } from '../online';
import { Button } from './components';
import { Icon } from './Icon';
import { C, PANEL_W, shadow, themed, sz } from './theme';

export function PlaceCard({ place, onGo, onAddStop, onClose, wide, top }: {
  place: Place & { sub?: string };
  onGo: () => void;
  onAddStop: () => void;
  onClose: () => void;
  wide: boolean;
  top: number;
}) {
  return (
    <View style={[s.card, { top }, wide && { right: undefined, width: PANEL_W }]}>
      <View style={s.head}>
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>{place.name}</Text>
          <Text style={s.sub} numberOfLines={1}>{place.sub || place.detail || 'Точка на карте'}</Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10} style={{ padding: 4 }}>
          <Icon name="close" size={sz(22)} color={C.sub} />
        </Pressable>
      </View>
      <View style={s.btns}>
        <Button text="Сюда" onPress={onGo} style={{ flex: 1 }} />
        <Button text="+ Заехать" kind="secondary" onPress={onAddStop} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

export function StopsPill({ stops, onRemove }: { stops: Stop[]; onRemove?: (idx: number) => void }) {
  if (!stops.length) return null;
  return (
    <View style={s.pill}>
      <Icon name="map-marker-check" size={sz(16)} color={C.blue} style={{ marginRight: 6 }} />
      <Text style={s.pillText} numberOfLines={1}>
        Остановки: {stops.map((s) => s.name).join(', ')}
      </Text>
    </View>
  );
}

const s = themed(() => ({
  card: { position: 'absolute', left: sz(12), right: sz(12), backgroundColor: C.card, borderRadius: sz(18), padding: sz(14), ...shadow },
  head: { flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: sz(17), fontWeight: '800', color: C.text },
  sub: { fontSize: sz(13), color: C.sub, marginTop: 2 },
  btns: { flexDirection: 'row', gap: sz(10), marginTop: sz(12) },
  pill: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.chip, borderRadius: sz(12), paddingHorizontal: sz(10), paddingVertical: sz(6), marginTop: sz(6) },
  pillText: { fontSize: sz(13), color: C.text, fontWeight: '600', flexShrink: 1 },
}));
