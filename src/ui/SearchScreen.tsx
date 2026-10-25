// Поиск «Куда?» — как в Яндексе/2ГИС: строка сверху, подсказки по мере ввода.
// Пока строка пустая: «Скачанные маршруты» (зелёным) и «Недавние».

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { fmtDistance, searchPlaces, type Place } from '../online';
import type { LatLon } from '../core/geo';
import type { Trip } from '../trips';
import type { RecentPlace } from '../recent';
import { C, themed, useWide, useInsets, PANEL_W, sz } from './theme';
import { Icon, type IconName } from './Icon';
import { AnimatedIcon } from './AnimatedIcon';
import { getLite } from './liteFlag';
import { abortListening, startListening, stopListening } from '../stt';

export function SearchScreen({ near, trips, recent, onPick, onClose, onOpenTrip, onDeleteTrip, onDeleteRecent, onClearRecent, onToast, onFuelCommand }: {
  near?: LatLon; trips: Trip[]; recent: RecentPlace[];
  onPick: (p: Place) => void; onClose: () => void;
  onOpenTrip: (t: Trip) => void; onDeleteTrip: (t: Trip) => void;
  onDeleteRecent: (p: RecentPlace) => void; onClearRecent: () => void;
  onToast: (s: string) => void; onFuelCommand: () => void;
}) {
  const { wide } = useWide();
  const { top } = useInsets();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ctrl = useRef<AbortController | null>(null);

  // ---------- Голосовой ввод ----------
  const [listening, setListening] = useState(false);
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!listening || getLite()) { pulse.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1.3, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [listening]);
  useEffect(() => () => { abortListening(); }, []);
  function toggleMic() {
    if (listening) { stopListening(); return; }
    setListening(true);
    startListening({
      onText: (t, final) => {
        setQ(t); // промежуточный текст сразу в строке, обычный поиск сработает сам
        if (final && /бензин|заправк/i.test(t)) onFuelCommand();
      },
      onEnd: () => setListening(false),
      onError: (m) => onToast(m),
    });
  }

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

  const short = q.trim().length < 2;
  const hint = near
    ? 'Улицы, дома и заведения ищем рядом с вами, а достопримечательности, вокзалы и города — везде.\nМожно и без поиска: зажмите палец на нужной точке карты.'
    : 'Пока не знаем, где вы, поэтому ищем по всей стране. Чтобы найти улицу в другом городе, допишите город: «Ленина, Ялта».';

  // Экран до ввода: скачанные поездки (зелёные) и недавние места
  const home = (
    <View>
      {trips.length > 0 && <View style={s.groupRow}><Text style={s.group}>СКАЧАННЫЕ МАРШРУТЫ</Text></View>}
      {trips.map((t) => {
        const ready = t.status === 'ready';
        const bad = t.status === 'error';
        const icon: IconName = ready ? 'check-circle' : bad ? 'alert-circle-outline' : 'progress-download';
        const pct = Math.max(0, Math.min(100, Math.round(t.totalPct)));
        return (
          <Pressable key={t.id} style={({ pressed }) => [s.trip, bad && { borderLeftColor: C.red }, pressed && { opacity: 0.7 }]} onPress={() => onOpenTrip(t)}>
            {!ready && !bad
              ? <AnimatedIcon name="loading" size={30} color={C.green} loop style={{ marginRight: 12 }} />
              : <Icon name={icon} size={26} color={bad ? C.red : C.green} style={{ marginRight: 12 }} />}
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>{t.name}</Text>
              <Text style={[s.detail, bad && { color: C.red }]} numberOfLines={2}>
                {ready ? `Скачано · ${t.mb ? `${t.mb} МБ` : 'работает без интернета'}` : bad ? (t.error || 'Ошибка загрузки') : `Скачивается… ${pct}%`}
              </Text>
              {!ready && !bad && <View style={s.track}><View style={[s.fill, { width: `${pct}%` }]} /></View>}
            </View>
            {(ready || bad) && (
              <Pressable hitSlop={10} style={{ padding: 6 }} onPress={() => onDeleteTrip(t)}>
                <AnimatedIcon name="trash" size={28} color={C.red} autoPlay={false} />
              </Pressable>
            )}
          </Pressable>
        );
      })}
      {recent.length > 0 && (
        <View style={s.groupRow}>
          <Text style={s.group}>НЕДАВНИЕ</Text>
          <Pressable onPress={onClearRecent} hitSlop={10}><Text style={s.link}>Очистить</Text></Pressable>
        </View>
      )}
      {recent.map((p) => (
        <Pressable key={`${p.lat},${p.lon},${p.usedAt}`} style={({ pressed }) => [s.item, pressed && { backgroundColor: C.chip }]} onPress={() => onPick(p)}>
          <View style={s.pinBox}><Icon name="history" size={20} color={C.blue} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.name} numberOfLines={1}>{p.name}</Text>
            {!!p.detail && <Text style={s.detail} numberOfLines={1}>{p.detail}</Text>}
          </View>
          <Pressable hitSlop={10} style={{ padding: 6 }} onPress={() => onDeleteRecent(p)}>
            <Icon name="close" size={20} color={C.sub} />
          </Pressable>
        </Pressable>
      ))}
      {!trips.length && !recent.length && <Text style={s.empty}>{hint}</Text>}
    </View>
  );

  return (
    <View style={[s.root, { paddingTop: top }, wide && { right: undefined, width: PANEL_W + 40, borderTopRightRadius: 24, borderBottomRightRadius: 24 }]}>
      <View style={s.bar}>
        <Pressable onPress={onClose} hitSlop={12} style={{ marginRight: 10 }}><Icon name="arrow-left" size={26} color={C.text} /></Pressable>
        <TextInput
          style={s.input}
          placeholder={listening ? 'Говорите…' : 'Куда поедем?'}
          placeholderTextColor={C.hint}
          value={q}
          onChangeText={setQ}
          autoFocus
          returnKeyType="search"
        />
        <Pressable onPress={toggleMic} hitSlop={10} style={{ paddingHorizontal: 6 }}>
          <Animated.View style={{ transform: [{ scale: pulse }] }}>
            <Icon name={listening ? 'microphone' : 'microphone-outline'} size={24} color={listening ? C.red : C.sub} />
          </Animated.View>
        </Pressable>
        {busy && <ActivityIndicator color={C.sub} />}
      </View>
      <FlatList
        data={short ? [] : items}
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
        ListEmptyComponent={short ? home : <Text style={s.empty}>{err}</Text>}
      />
    </View>
  );
}

const ICON: Record<string, IconName> = { address: 'map-marker-outline', poi: 'store-outline', landmark: 'star-outline', settlement: 'city-variant-outline' };

const s = themed(() => ({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.card, paddingTop: sz(12) },
  bar: { flexDirection: 'row', alignItems: 'center', marginHorizontal: sz(12), backgroundColor: C.chip, borderRadius: sz(16), paddingHorizontal: sz(12), height: sz(52) },
  input: { flex: 1, fontSize: sz(17), color: C.text },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: sz(16), paddingVertical: sz(12), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  pinBox: { width: sz(36), height: sz(36), borderRadius: sz(18), backgroundColor: C.blueSoft, alignItems: 'center', justifyContent: 'center', marginRight: sz(12) },
  name: { fontSize: sz(16), color: C.text, fontWeight: '600' },
  detail: { fontSize: sz(13), color: C.sub, marginTop: 2 },
  dist: { fontSize: sz(13), color: C.sub, marginLeft: sz(8) },
  empty: { fontSize: sz(14), color: C.sub, padding: sz(20), lineHeight: sz(20) },
  groupRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: sz(18), marginBottom: sz(4), marginHorizontal: sz(16) },
  group: { fontSize: sz(11), fontWeight: '700', color: C.hint, letterSpacing: 0.6 },
  link: { color: C.blue, fontWeight: '700', fontSize: sz(13) },
  trip: { flexDirection: 'row', alignItems: 'center', marginHorizontal: sz(12), marginTop: sz(8), padding: sz(12), borderRadius: sz(14), backgroundColor: C.chip, borderLeftWidth: 4, borderLeftColor: C.green },
  track: { height: sz(5), backgroundColor: C.line, borderRadius: sz(3), marginTop: sz(8), overflow: 'hidden' },
  fill: { height: sz(5), backgroundColor: C.green },
}));
