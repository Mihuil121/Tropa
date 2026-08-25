// Поиск «Куда?» — как в Яндексе/2ГИС: строка сверху, подсказки по мере ввода.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { fmtDistance, searchPlaces, type Place } from '../online';
import type { LatLon } from '../core/geo';
import { C, themed, useWide, useInsets, PANEL_W, sz } from './theme';
import { Icon, type IconName } from './Icon';

export function SearchScreen({ near, onPick, onClose }: { near?: LatLon; onPick: (p: Place) => void; onClose: () => void }) {
  const { wide } = useWide();
  const { top } = useInsets();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    // Пауза 450 мс после ввода: не нагружаем бесплатный сервер на каждую букву
    const t = setTimeout(async () => {
      ctrl.current?.abort();
      if (q.trim().length < 2) { setItems([]); setErr(''); return; }
      const c = new AbortController();
      ctrl.current = c;
      setBusy(true);
      try {
        const r = await searchPlaces(q, near, c.signal);
        setItems(r);
        setErr(r.length ? '' : 'Ничего не нашлось');
      } catch (e: any) {
        if (e?.name !== 'AbortError') setErr(String(e?.message ?? 'Нет интернета. Зажмите точку на карте, чтобы выбрать её.'));
      } finally {
        setBusy(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <View style={[s.root, { paddingTop: top }, wide && { right: undefined, width: PANEL_W + 40, borderTopRightRadius: 24, borderBottomRightRadius: 24 }]}>
      <View style={s.bar}>
        <Pressable onPress={onClose} hitSlop={12} style={{ marginRight: 10 }}><Icon name="arrow-left" size={26} color={C.text} /></Pressable>
        <TextInput
          style={s.input}
          placeholder="Куда поедем?"
          placeholderTextColor={C.hint}
          value={q}
          onChangeText={setQ}
          autoFocus
          returnKeyType="search"
        />
        {busy && <ActivityIndicator color={C.sub} />}
      </View>
      <FlatList
        data={items}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(it, i) => `${it.lat},${it.lon},${i}`}
        renderItem={({ item }) => (
          <Pressable style={({ pressed }) => [s.item, pressed && { backgroundColor: C.chip }]} onPress={() => onPick(item)}>
            <View style={s.pinBox}><Icon name={ICON[item.kind ?? 'poi']} size={20} color={C.blue} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>{item.name}</Text>
              {!!item.detail && <Text style={s.detail} numberOfLines={1}>{item.detail}</Text>}
            </View>
            {item.distKm != null && <Text style={s.dist}>{fmtDistance(item.distKm * 1000)}</Text>}
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={s.empty}>{err || (near
            ? 'Улицы, дома и заведения ищем рядом с вами, а достопримечательности, вокзалы и города — везде.\nМожно и без поиска: зажмите палец на нужной точке карты.'
            : 'Пока не знаем, где вы, поэтому ищем по всей стране. Чтобы найти улицу в другом городе, допишите город: «Ленина, Ялта».')}</Text>
        }
      />
    </View>
  );
}

const ICON: Record<string, IconName> = { address: 'map-marker-outline', poi: 'store-outline', landmark: 'star-outline', settlement: 'city-variant-outline' };

const s = themed(() => ({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.card, paddingTop: sz(12) },
  bar: { flexDirection: 'row', alignItems: 'center', marginHorizontal: sz(12), backgroundColor: C.chip, borderRadius: sz(16), paddingHorizontal: sz(12), height: sz(52) },
  back: { fontSize: sz(24), color: C.text, marginRight: sz(10) },
  input: { flex: 1, fontSize: sz(17), color: C.text },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: sz(16), paddingVertical: sz(12), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  pinBox: { width: sz(36), height: sz(36), borderRadius: sz(18), backgroundColor: C.blueSoft, alignItems: 'center', justifyContent: 'center', marginRight: sz(12) },
  name: { fontSize: sz(16), color: C.text, fontWeight: '600' },
  detail: { fontSize: sz(13), color: C.sub, marginTop: 2 },
  dist: { fontSize: sz(13), color: C.sub, marginLeft: sz(8) },
  empty: { fontSize: sz(14), color: C.sub, padding: sz(20), lineHeight: sz(20) },
}));
