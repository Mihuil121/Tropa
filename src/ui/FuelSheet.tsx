// Нижняя панель «Заправки рядом»: список по расстоянию, фильтр по топливу, отметки «есть/нет» (только на этом телефоне).

import { Pressable, ScrollView, Text, View } from 'react-native';
import { fmtDistance } from '../online';
import { FUEL_LABEL, matchesFuel, statusOf, type FuelKind, type FuelReports, type FuelStation, type FuelStatus } from '../fuel';
import { Icon } from './Icon';
import { C, ui, themed, useWide, sz } from './theme';

const KINDS: FuelKind[] = ['92', '95', '98', '100', 'diesel', 'lpg'];

function statusView(st: FuelStatus): { text: string; color: string } {
  if (st === 'yes') return { text: 'Есть топливо', color: C.green };
  if (st === 'no') return { text: 'Нет топлива', color: C.red };
  return { text: 'Нет данных', color: C.hint };
}

export function FuelSheet({ stations, reports, filter, onFilter, busy, note, onRefresh, onClose, onRoute, onAddStop, onMark }: {
  stations: FuelStation[]; reports: FuelReports; filter: FuelKind | null; onFilter: (k: FuelKind | null) => void;
  busy: boolean; note: string; onRefresh: () => void; onClose: () => void;
  onRoute: (st: FuelStation) => void; onAddStop?: (st: FuelStation) => void;
  onMark: (st: FuelStation, status: 'yes' | 'no') => void;
}) {
  const { wide, height } = useWide();
  const list = stations.filter((st) => matchesFuel(st, filter));
  const options: (FuelKind | null)[] = [null, ...KINDS];
  return (
    <View style={[ui.sheet, wide && ui.sheetWide]}>
      <View style={ui.grabber} />
      <View style={s.head}>
        <Text style={[ui.h1, { flex: 1 }]}>Заправки рядом</Text>
        <Pressable onPress={onRefresh} hitSlop={10} style={s.headBtn}><Icon name="refresh" size={sz(22)} color={busy ? C.hint : C.blue} /></Pressable>
        <Pressable onPress={onClose} hitSlop={10} style={s.headBtn}><Icon name="close" size={sz(22)} color={C.text} /></Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: sz(8), paddingVertical: sz(6) }}>
        {options.map((k) => (
          <Pressable key={k ?? 'all'} onPress={() => onFilter(k)} style={[s.fchip, filter === k && { backgroundColor: C.blue }]}>
            <Text style={[s.fchipText, filter === k && { color: '#fff' }]}>{k ? FUEL_LABEL[k] : 'Все'}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {!!note && <Text style={[ui.sub, { marginTop: 4 }]}>{note}</Text>}
      <ScrollView style={{ maxHeight: Math.round(height * 0.36) }} showsVerticalScrollIndicator={false}>
        {list.length === 0 && !busy && <Text style={[ui.sub, s.empty]}>Подходящих заправок не нашлось.</Text>}
        {list.map((st) => {
          const v = statusView(statusOf(reports, st.id));
          return (
            <View key={st.id} style={s.item}>
              <View style={s.top}>
                <View style={s.letter}><Text style={s.letterText}>{(st.brand || st.name).slice(0, 1).toUpperCase()}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>{st.name}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                    <View style={[s.dot, { backgroundColor: v.color }]} />
                    <Text style={[s.detail, { color: v.color }]}>{v.text}</Text>
                    <Text style={s.detail}> · ≈ {fmtDistance(st.distM)}</Text>
                  </View>
                  <Text style={s.detail} numberOfLines={1}>
                    {st.fuels.length ? st.fuels.map((k) => FUEL_LABEL[k]).join(', ') : 'топливо не указано'}{st.openingHours ? ` · ${st.openingHours}` : ''}
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
                    <Text style={[s.btnText, { color: C.blue }]}>Заехать</Text>
                  </Pressable>
                )}
                <Pressable style={s.btn} onPress={() => onMark(st, 'yes')}><Text style={[s.btnText, { color: C.green }]}>Есть бензин</Text></Pressable>
                <Pressable style={s.btn} onPress={() => onMark(st, 'no')}><Text style={[s.btnText, { color: C.red }]}>Нет бензина</Text></Pressable>
              </View>
            </View>
          );
        })}
      </ScrollView>
      <Text style={s.foot}>Адреса — из OpenStreetMap, о наличии топлива они не знают. Отметки «есть / нет» хранятся только на вашем телефоне и действуют 12 часов.</Text>
    </View>
  );
}

const s = themed(() => ({
  head: { flexDirection: 'row', alignItems: 'center' },
  headBtn: { padding: sz(6), marginLeft: sz(4) },
  fchip: { backgroundColor: C.chip, borderRadius: sz(14), paddingHorizontal: sz(12), paddingVertical: sz(6) },
  fchipText: { fontSize: sz(13), fontWeight: '700', color: C.text },
  empty: { padding: sz(12) },
  item: { paddingVertical: sz(10), borderBottomWidth: 1, borderBottomColor: C.line },
  top: { flexDirection: 'row', alignItems: 'center' },
  letter: { width: sz(40), height: sz(40), borderRadius: sz(20), backgroundColor: C.blueSoft, alignItems: 'center', justifyContent: 'center', marginRight: sz(12) },
  letterText: { fontSize: sz(18), fontWeight: '800', color: C.blue },
  name: { fontSize: sz(16), fontWeight: '700', color: C.text },
  detail: { fontSize: sz(13), color: C.sub },
  dot: { width: sz(8), height: sz(8), borderRadius: sz(4), marginRight: sz(6) },
  btns: { flexDirection: 'row', gap: sz(8), marginTop: sz(8) },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: C.chip, borderRadius: sz(12), paddingHorizontal: sz(12), paddingVertical: sz(8) },
  btnText: { fontSize: sz(13), fontWeight: '700' },
  foot: { fontSize: sz(11), color: C.hint, marginTop: sz(8) },
}));
