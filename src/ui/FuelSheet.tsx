// Экран/шторка «Заправки рядом»: список по расстоянию, кнопка построить маршрут или добавить остановку.

import { Pressable, ScrollView, Text, View } from 'react-native';
import { fmtDistance } from '../online';
import type { FuelStation, FuelReports } from '../fuel';
import { Icon } from './Icon';
import { C, ui, themed, useWide, sz } from './theme';

export function FuelSheet({ stations, busy, note, reason, onRefresh, onClose, onRoute, onAddStop }: {
  stations: FuelStation[]; reports?: FuelReports; busy: boolean; note: string; reason?: 'ok' | 'empty' | 'network'; onRefresh: () => void; onClose: () => void;
  onRoute: (st: FuelStation) => void; onAddStop?: (st: FuelStation) => void;
  onMark?: (st: FuelStation, status: 'yes' | 'low' | 'no') => void;
}) {
  const { wide, height } = useWide();
  const hasError = reason === 'network';
  return (
    <View style={[ui.sheet, wide && ui.sheetWide]}>
      <View style={ui.grabber} />
      <View style={s.head}>
        <Text style={[ui.h1, { flex: 1 }]}>Заправки поблизости</Text>
        <Pressable onPress={onRefresh} hitSlop={10} style={s.headBtn}><Icon name="refresh" size={sz(22)} color={busy ? C.hint : C.blue} /></Pressable>
        <Pressable onPress={onClose} hitSlop={10} style={s.headBtn}><Icon name="close" size={sz(22)} color={C.text} /></Pressable>
      </View>
      {!!note && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, marginBottom: 8 }}>
          <Text style={[ui.sub, { flex: 1, color: hasError ? C.redText : C.sub }]}>{note}</Text>
          {hasError && (
            <Pressable onPress={onRefresh} style={s.retryBtn}><Text style={s.retryText}>Повторить</Text></Pressable>
          )}
        </View>
      )}
      <ScrollView style={{ maxHeight: Math.round(height * 0.42) }} showsVerticalScrollIndicator={false}>
        {stations.length === 0 && !busy && <Text style={[ui.sub, s.empty]}>Поблизости заправок не найдено.</Text>}
        {stations.map((st) => {
          return (
            <View key={st.id} style={s.item}>
              <View style={s.top}>
                <View style={s.letter}><Icon name="gas-station" size={sz(20)} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>{st.name}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                    <Text style={[s.detail, { color: C.blue, fontWeight: '700' }]}>≈ {fmtDistance(st.distM)}</Text>
                  </View>
                  <Text style={s.detail} numberOfLines={1}>
                    {st.brand ? `${st.brand}` : ''}{st.openingHours ? ` · ${st.openingHours}` : ''}
                  </Text>
                </View>
              </View>
              <View style={s.btns}>
                <Pressable style={[s.btn, { backgroundColor: C.blue }]} onPress={() => onRoute(st)}>
                  <Icon name="navigation-variant" size={sz(16)} color="#fff" style={{ marginRight: 4 }} />
                  <Text style={[s.btnText, { color: '#fff' }]}>Маршрут</Text>
                </Pressable>
                {onAddStop && (
                  <Pressable style={s.btn} onPress={() => onAddStop(st)}>
                    <Icon name="map-marker-plus" size={sz(16)} color={C.blue} style={{ marginRight: 4 }} />
                    <Text style={[s.btnText, { color: C.blue }]}>Заехать по пути</Text>
                  </Pressable>
                )}
              </View>
            </View>
          );
        })}
      </ScrollView>
      <Text style={s.foot}>Данные о заправках получены из OpenStreetMap.</Text>
    </View>
  );
}

const s = themed(() => ({
  head: { flexDirection: 'row', alignItems: 'center' },
  headBtn: { padding: sz(6), marginLeft: sz(4) },
  empty: { padding: sz(12), textAlign: 'center' },
  item: { paddingVertical: sz(12), borderBottomWidth: 1, borderBottomColor: C.line },
  top: { flexDirection: 'row', alignItems: 'center' },
  letter: { width: sz(40), height: sz(40), borderRadius: sz(20), backgroundColor: C.blueSoft, alignItems: 'center', justifyContent: 'center', marginRight: sz(12) },
  name: { fontSize: sz(16), fontWeight: '700', color: C.text },
  detail: { fontSize: sz(13), color: C.sub },
  btns: { flexDirection: 'row', gap: sz(8), marginTop: sz(10) },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: C.chip, borderRadius: sz(12), paddingHorizontal: sz(12), paddingVertical: sz(8) },
  btnText: { fontSize: sz(13), fontWeight: '700' },
  foot: { fontSize: sz(11), color: C.hint, marginTop: sz(10), textAlign: 'center' },
  retryBtn: { backgroundColor: C.blueSoft, borderRadius: sz(10), paddingHorizontal: sz(10), paddingVertical: sz(4), marginLeft: sz(6) },
  retryText: { color: C.blue, fontWeight: '700', fontSize: sz(12) },
}));
