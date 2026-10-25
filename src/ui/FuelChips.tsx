// Быстрые кнопки под строкой «Куда поедем?». Пока одна: «Бензин».

import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Icon } from './Icon';
import { C, PANEL_W, shadow, themed, sz } from './theme';

export function FuelChips({ on, busy, onPress, top, wide }: { on: boolean; busy: boolean; onPress: () => void; top: number; wide: boolean }) {
  return (
    <View pointerEvents="box-none" style={[s.row, { top }, wide && { right: undefined, width: PANEL_W }]}>
      <Pressable onPress={onPress} style={({ pressed }) => [s.chip, on && { backgroundColor: C.blue }, pressed && { opacity: 0.8 }]}>
        <Icon name="gas-station" size={sz(18)} color={on ? '#fff' : C.blue} style={{ marginRight: 6 }} />
        <Text style={[s.text, on && { color: '#fff' }]}>Бензин</Text>
        {busy && <ActivityIndicator size="small" color={on ? '#fff' : C.sub} style={{ marginLeft: 8 }} />}
      </Pressable>
    </View>
  );
}

const s = themed(() => ({
  row: { position: 'absolute', left: sz(12), right: sz(12), flexDirection: 'row' },
  chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: sz(18), paddingHorizontal: sz(14), height: sz(38), ...shadow },
  text: { fontSize: sz(14), fontWeight: '700', color: C.text },
}));
