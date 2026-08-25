// Раздел настроек «Карты без интернета»: скачать город, окрестности или всю дорогу по маршруту.

import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { LatLon } from '../core/geo';
import { searchPlaces, type Place } from '../online';
import { deleteArea, download, listAreas, planCity, planRoute, type AreaPlan, type PackInfo } from '../offlineMaps';
import { Button, Row, Section } from './components';
import { Icon } from './Icon';
import { C, ui } from './theme';

export function OfflineMaps({ near, route, routeName, usingFileMap }: {
  near?: LatLon; route: LatLon[] | null; routeName?: string; usingFileMap: boolean;
}) {
  const [areas, setAreas] = useState<PackInfo[]>([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<AreaPlan | null>(null);
  const [progress, setProgress] = useState<{ name: string; pct: number; err?: string } | null>(null);

  const refresh = () => listAreas().then(setAreas);
  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, []);

  async function find() {
    if (q.trim().length < 2) return;
    setBusy(true);
    try {
      const r = await searchPlaces(q, near);
      // Сначала города и посёлки, потом всё остальное
      setFound([...r.filter((p) => p.kind === 'settlement'), ...r.filter((p) => p.kind !== 'settlement')].slice(0, 5));
    } catch { setFound([]); }
    setBusy(false);
  }

  function start(p: AreaPlan) {
    setPlan(null); setFound([]);
    setProgress({ name: p.name, pct: 0 });
    download(p, (pct, done, err) => {
      setProgress(err ? { name: p.name, pct, err } : done ? null : { name: p.name, pct });
      if (done) refresh();
    });
  }

  return (
    <View>
      <Section icon="map-outline" title="Карты без интернета" />
      <Text style={[ui.sub, s.p]}>
        Скачайте заранее, пока есть Wi‑Fi: город, окрестности или всю дорогу. Потом карта показывается и без сети.
        {usingFileMap ? ' (Сейчас загружена своя карта из файла — она и так офлайн.)' : ''}
      </Text>

      <View style={{ flexDirection: 'row' }}>
        {near && <Button small kind="secondary" text="Вокруг меня (15 км)" onPress={() => setPlan(planCity('Вокруг меня', near, 15))} />}
        {route && route.length > 1 && <Button small kind="secondary" style={{ marginLeft: near ? 8 : 0 }} text="Вдоль маршрута" onPress={() => setPlan(planRoute(`Дорога: ${routeName ?? 'маршрут'}`, route))} />}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
        <TextInput style={[s.input, { flex: 1 }]} value={q} onChangeText={setQ} placeholder="Город: Ялта, Симферополь…" placeholderTextColor={C.hint} onSubmitEditing={find} returnKeyType="search" />
        <Button small text="Найти" style={{ flex: 0, paddingHorizontal: 16, marginLeft: 8 }} onPress={find} />
      </View>
      {busy && <ActivityIndicator style={{ marginTop: 8 }} color={C.sub} />}
      {found.map((p, i) => (
        <Row key={i} title={p.name} sub={p.detail} onPress={() => setPlan(planCity(p.name, p, p.kind === 'settlement' ? 12 : 5))} right={<Text style={s.link}>Выбрать</Text>} />
      ))}

      {plan && (
        <View style={s.confirm}>
          <Text style={ui.body}>Скачать «{plan.name}»?</Text>
          <Text style={ui.sub}>≈ {plan.tiles.toLocaleString('ru')} плиток, примерно {plan.mb < 1 ? 1 : plan.mb} МБ. Лучше по Wi‑Fi.</Text>
          {plan.mb > 1500 && <Text style={[ui.sub, { color: C.red }]}>Очень много — проверьте свободное место.</Text>}
          <View style={{ flexDirection: 'row', marginTop: 8 }}>
            <Button small text="Скачать" onPress={() => start(plan)} />
            <Button small kind="secondary" style={{ marginLeft: 8 }} text="Отмена" onPress={() => setPlan(null)} />
          </View>
        </View>
      )}

      {progress && (
        <View style={s.confirm}>
          <Text style={ui.body}>{progress.err ? 'Ошибка' : 'Качаю'} «{progress.name}» — {Math.floor(progress.pct)}%</Text>
          <View style={s.bar}><View style={[s.fill, { width: `${Math.min(100, progress.pct)}%` }]} /></View>
          {!!progress.err && <Text style={[ui.sub, { color: C.red }]}>{progress.err}</Text>}
        </View>
      )}

      {areas.map((a) => (
        <Row key={a.group} title={a.name}
          sub={a.percent >= 99.9 ? `готово, ${a.mb} МБ` : `${a.state}: ${Math.floor(a.percent)}%, ${a.mb} МБ`}
          right={<Pressable hitSlop={10} onPress={() => deleteArea(a.id).then(refresh)} style={{ padding: 6 }}><Icon name="delete-outline" size={24} color={C.red} /></Pressable>} />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  p: { marginVertical: 6, lineHeight: 19 },
  link: { color: C.blue, fontWeight: '600', fontSize: 14 },
  input: { backgroundColor: C.chip, borderRadius: 12, paddingHorizontal: 12, height: 46, fontSize: 15, color: C.text },
  confirm: { backgroundColor: '#fff8db', borderRadius: 12, padding: 12, marginTop: 10 },
  bar: { height: 6, backgroundColor: C.line, borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  fill: { height: 6, backgroundColor: C.blue },
});
