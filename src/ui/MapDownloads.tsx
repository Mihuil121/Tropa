// Экран «Скачать карты»: отмечаете галочками города (или находите любой другой) → «Скачать».
// Города качаются по очереди, по одному; экран можно закрыть — загрузка продолжится.

import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { LatLon } from '../core/geo';
import { CITIES } from '../cities';
import { searchPlaces } from '../online';
import {
  cancelQueued, deleteArea, enqueue, listAreas, packTrip, planCity, planRoute, queueState, setWithCells, subscribeQueue,
  type AreaPlan, type PackInfo, type QueueState,
} from '../offlineMaps';
import { Button } from './components';
import type { Trip } from '../trips';
import { Icon, type IconName } from './Icon';
import { AnimatedIcon } from './AnimatedIcon';
import { C, ui, themed, useWide, PANEL_W, sz } from './theme';

type Item = { key: string; name: string; detail: string; plan: AreaPlan };

export function MapDownloads({ near, route, routeName, usingFileMap, onClose, areaCells, cellsTotal, showCells, onShowCells, trips, onDeleteTrip }: {
  near?: LatLon; route: LatLon[] | null; routeName?: string; usingFileMap: boolean; onClose: () => void;
  areaCells: Record<string, number>; cellsTotal: number; showCells: boolean; onShowCells: (v: boolean) => void;
  trips: Trip[]; onDeleteTrip: (t: Trip) => void;
}) {
  const { wide } = useWide();
  const [areas, setAreas] = useState<PackInfo[]>([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Record<string, Item>>({});
  const [qs, setQs] = useState<QueueState>(queueState());

  const refresh = () => listAreas().then(setAreas);
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, []);
  useEffect(() => subscribeQueue(() => { setQs(queueState()); }), []);

  // Предложенные варианты: рядом, вдоль маршрута, города из списка (ближние — выше)
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (near) out.push({ key: 'near', name: 'Вокруг меня', detail: 'квадрат 30 × 30 км', plan: planCity('Вокруг меня', near, 15) });
    if (route && route.length > 1) out.push({ key: 'route', name: `Дорога: ${routeName ?? 'маршрут'}`, detail: 'полоса вдоль всего маршрута', plan: planRoute(`Дорога: ${routeName ?? 'маршрут'}`, route) });
    const cities = [...CITIES].sort((a, b) => (near ? d2(a, near) - d2(b, near) : 0));
    for (const c of cities) out.push({ key: `c:${c.name}`, name: c.name, detail: c.region, plan: planCity(c.name, c, c.r) });
    return out;
  }, [near?.lat, near?.lon, route, routeName]);

  async function find() {
    if (q.trim().length < 2) { setFound([]); return; }
    setBusy(true);
    try {
      const r = await searchPlaces(q, near);
      const towns = [...r.filter((p) => p.kind === 'settlement'), ...r.filter((p) => p.kind !== 'settlement')].slice(0, 6);
      setFound(towns.map((p, i) => ({ key: `s:${i}:${p.name}`, name: p.name, detail: p.detail, plan: planCity(p.name, p, p.kind === 'settlement' ? 12 : 5) })));
    } catch { setFound([]); }
    setBusy(false);
  }

  const done = (name: string) => areas.find((a) => a.name === name && !a.tripId && a.percent >= 99.9);
  const inQueue = (name: string) => qs.current?.name === name || qs.waiting.includes(name);
  const toggle = (it: Item) => setSel((s) => { const n = { ...s }; if (n[it.key]) delete n[it.key]; else n[it.key] = it; return n; });
  const chosen = Object.values(sel);
  const chosenMb = chosen.reduce((a, it) => a + Math.max(1, it.plan.mb), 0);

  function startSelected() {
    for (const it of chosen) enqueue(it.plan);
    setSel({});
  }

  const row = (it: Item) => {
    const ok = done(it.name);
    const queued = inQueue(it.name);
    const checked = !!sel[it.key];
    const icon: IconName = ok ? 'check-circle' : queued ? 'progress-download' : checked ? 'checkbox-marked' : 'checkbox-blank-outline';
    const color = ok ? C.green : queued || checked ? C.blue : C.hint;
    return (
      <Pressable key={it.key} style={({ pressed }) => [s.row, pressed && !ok && !queued && { backgroundColor: C.chip }]}
        onPress={() => { if (!ok && !queued) toggle(it); }}>
        <Icon name={icon} size={26} color={color} style={{ marginRight: 12 }} />
        <View style={{ flex: 1 }}>
          <Text style={s.name} numberOfLines={1}>{it.name}</Text>
          <Text style={s.detail} numberOfLines={1}>
            {ok ? `скачано · ${ok.mb} МБ · ${areaCells[it.name] != null ? (areaCells[it.name] ? `вышек: ${areaCells[it.name]}` : 'вышек в базе нет') : 'без вышек'}` : queued ? (qs.current?.name === it.name ? `${qs.current.phase === 'вышки' ? 'вышки' : 'карта'} · ${Math.floor(qs.current.pct)}%` : 'в очереди') : [it.detail, `≈ ${Math.max(1, it.plan.mb)} МБ`].filter(Boolean).join(' · ')}
          </Text>
        </View>
        {ok && !queued && areaCells[it.name] == null && (
          <Pressable hitSlop={10} style={s.addCells} onPress={() => enqueue({ ...it.plan, cellsOnly: true })}>
            <Icon name="radio-tower" size={18} color={C.blue} />
            <Text style={s.addCellsText}>+ вышки</Text>
          </Pressable>
        )}
        {ok && (
          <Pressable hitSlop={10} style={{ padding: 6 }} onPress={() => deleteArea(ok.id).then(refresh)}>
            <Icon name="delete-outline" size={24} color={C.red} />
          </Pressable>
        )}
        {queued && qs.current?.name !== it.name && (
          <Pressable hitSlop={10} style={{ padding: 6 }} onPress={() => cancelQueued(it.name)}>
            <Icon name="close" size={22} color={C.sub} />
          </Pressable>
        )}
      </Pressable>
    );
  };

  const extra = areas.filter((a) => !a.tripId && !items.some((it) => it.name === a.name) && !found.some((it) => it.name === a.name));
  const totalMb = areas.reduce((m, a) => m + a.mb, 0);

  return (
    <View style={[s.root, wide && { right: undefined, width: PANEL_W + 40, borderTopRightRadius: 24, borderBottomRightRadius: 24 }]}>
      <View style={s.head}>
        <Pressable onPress={onClose} hitSlop={12} style={{ marginRight: 12 }}><Icon name="arrow-left" size={26} color={C.text} /></Pressable>
        <Text style={ui.h1}>Карты без интернета</Text>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: chosen.length ? 110 : 30 }}>
        {route && route.length > 1 && (
          <Pressable style={[s.cellsOpt, { backgroundColor: C.blue, marginTop: 8 }]} onPress={() => {
            packTrip(routeName ? `Маршрут «${routeName}»` : 'Текущий маршрут', route);
          }}>
            <Icon name="car-outline" size={28} color="#fff" style={{ marginRight: 12 }} />
            <View style={{ flex: 1 }}>
              <Text style={[ui.body, { color: '#fff', fontWeight: '700' }]}>Режим «Поездка»: скачать всё</Text>
              <Text style={[ui.sub, { color: '#dbe6ff' }]}>Скачает карту коридора, вышки и знаки скорости для вашего маршрута.</Text>
            </View>
            <Icon name="download" size={24} color="#fff" />
          </Pressable>
        )}

        <Text style={[ui.sub, s.p]}>
          Отметьте города и нажмите «Скачать» — лучше по Wi‑Fi. Потом карта этих мест показывается и без сети.
          Качается по одному городу; экран можно закрыть.
          {usingFileMap ? '\nСейчас загружена своя карта из файла — она и так работает офлайн.' : ''}
        </Text>

        {qs.current && (
          <View style={s.progress}>
            <Text style={ui.body}>{qs.current.phase === 'вышки' ? 'Вышки' : 'Карта'} «{qs.current.name}» — {Math.floor(qs.current.pct)}%{qs.waiting.length ? ` · ещё в очереди: ${qs.waiting.length}` : ''}</Text>
            <View style={s.bar}><View style={[s.fill, { width: `${Math.min(100, qs.current.pct)}%` }]} /></View>
            {!!qs.current.err && <Text style={[ui.sub, { color: C.amber, marginTop: 4 }]}>{qs.current.err}</Text>}
          </View>
        )}

        <View style={s.cellsOpt}>
          <Icon name="radio-tower" size={22} color={C.blue} style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text style={ui.body}>Вместе с картой — вышки</Text>
            <Text style={ui.sub}>Координаты сотовых вышек этой области (база OpenCelliD). Нужны, чтобы находить место, когда GPS глушат.</Text>
          </View>
          <Switch value={qs.withCells} onValueChange={setWithCells} />
        </View>
        <View style={[s.cellsOpt, { marginTop: 8 }]}>
          <Icon name="map-marker-radius-outline" size={22} color={C.blue} style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text style={ui.body}>Показать вышки на карте</Text>
            <Text style={ui.sub}>Сейчас в телефоне: {cellsTotal.toLocaleString('ru')} вышек</Text>
          </View>
          <Switch value={showCells} onValueChange={onShowCells} />
        </View>

        <View style={s.search}>
          <Icon name="magnify" size={22} color={C.sub} style={{ marginRight: 8 }} />
          <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="Другой город или посёлок…" placeholderTextColor={C.hint}
            onSubmitEditing={find} returnKeyType="search" />
          {busy ? <ActivityIndicator color={C.sub} /> : !!q && <Pressable onPress={find} hitSlop={8}><Text style={s.link}>Найти</Text></Pressable>}
        </View>
        {found.length > 0 && <Text style={s.group}>НАЙДЕНО</Text>}
        {found.map(row)}

        <Text style={[ui.sub, s.p]}>Занято картами на телефоне: {totalMb} МБ</Text>
        {trips.length > 0 && <Text style={s.group}>ПОЕЗДКИ</Text>}
        {trips.map((t) => (
          <View key={t.id} style={s.row}>
            {t.status === 'queued' || t.status === 'downloading' ? (
              <AnimatedIcon name="loading" size={30} color={C.blue} loop style={{ marginRight: 12 }} />
            ) : (
              <Icon name={t.status === 'ready' ? 'check-circle' : 'alert-circle-outline'} size={26}
                color={t.status === 'error' ? C.red : t.status === 'ready' ? C.green : C.blue} style={{ marginRight: 12 }} />
            )}
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>{t.name}</Text>
              <Text style={s.detail} numberOfLines={2}>
                {t.status === 'ready' ? `скачано · ${t.mb} МБ` : t.status === 'error' ? (t.error || 'ошибка загрузки') : `скачивается · ${Math.floor(t.totalPct)}%`}
              </Text>
            </View>
            {(t.status === 'ready' || t.status === 'error') && (
              <Pressable hitSlop={10} style={{ padding: 6 }} onPress={() => onDeleteTrip(t)}>
                <Icon name="delete-outline" size={24} color={C.red} />
              </Pressable>
            )}
          </View>
        ))}

        {extra.length > 0 && <Text style={s.group}>УЖЕ СКАЧАНО</Text>}
        {extra.map((a) => (
          <View key={a.group} style={s.row}>
            <Icon name={a.percent >= 99.9 ? 'check-circle' : 'progress-download'} size={26} color={a.percent >= 99.9 ? C.green : C.blue} style={{ marginRight: 12 }} />
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>{a.name}</Text>
              <Text style={s.detail}>{a.percent >= 99.9 ? `скачано · ${a.mb} МБ` : `${Math.floor(a.percent)}% · ${a.mb} МБ`}</Text>
            </View>
            <Pressable hitSlop={10} style={{ padding: 6 }} onPress={() => deleteArea(a.id).then(refresh)}><Icon name="delete-outline" size={24} color={C.red} /></Pressable>
          </View>
        ))}

        <Text style={s.group}>{near ? 'РЯДОМ И ПО ПУТИ' : 'ГОРОДА'}</Text>
        {items.map(row)}
      </ScrollView>

      {chosen.length > 0 && (
        <View style={s.footer}>
          <Button text={`Скачать: ${chosen.length} · ≈ ${chosenMb} МБ`} onPress={startSelected} />
        </View>
      )}
    </View>
  );
}

const d2 = (a: LatLon, b: LatLon) => (a.lat - b.lat) ** 2 + ((a.lon - b.lon) * Math.cos((b.lat * Math.PI) / 180)) ** 2;

const s = themed(() => ({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.card, paddingTop: sz(44), elevation: 30, zIndex: 30 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: sz(16), paddingBottom: sz(6) },
  p: { marginHorizontal: sz(16), marginVertical: sz(6), lineHeight: sz(19) },
  progress: { backgroundColor: C.blueSoft, borderRadius: sz(14), padding: sz(12), marginHorizontal: sz(16), marginTop: sz(6) },
  bar: { height: sz(6), backgroundColor: C.card, borderRadius: sz(3), marginTop: sz(8), overflow: 'hidden' },
  fill: { height: sz(6), backgroundColor: C.blue },
  addCells: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.blueSoft, borderRadius: sz(12), paddingHorizontal: sz(8), paddingVertical: sz(5), marginRight: sz(4) },
  addCellsText: { color: C.blue, fontWeight: '700', fontSize: sz(12), marginLeft: sz(3) },
  cellsOpt: { flexDirection: 'row', alignItems: 'center', marginHorizontal: sz(16), marginTop: sz(12), padding: sz(12), borderRadius: sz(14), backgroundColor: C.chip },
  search: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.chip, borderRadius: sz(14), paddingHorizontal: sz(12), height: sz(48), marginHorizontal: sz(16), marginTop: sz(12) },
  input: { flex: 1, fontSize: sz(16), color: C.text },
  link: { color: C.blue, fontWeight: '700', fontSize: sz(15) },
  group: { fontSize: sz(11), fontWeight: '700', color: C.hint, letterSpacing: 0.6, marginTop: sz(18), marginBottom: 2, marginHorizontal: sz(16) },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: sz(16), paddingVertical: sz(11), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  name: { fontSize: sz(16), fontWeight: '600', color: C.text },
  detail: { fontSize: sz(13), color: C.sub, marginTop: 2 },
  footer: { position: 'absolute', left: sz(16), right: sz(16), bottom: sz(22), flexDirection: 'row' },
}));
