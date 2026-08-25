// Настройки: карт, визуального стиля, трафика, датчиков и сведений о приложении.

import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { Kind, Loaded, Settings } from '../data';
import type { ObdState } from '../obdLink';
import { Button, Row } from './components';
import { Icon, type IconName } from './Icon';
import type { LatLon } from '../core/geo';
import { C, ui, themed, useWide, useInsets, sz } from './theme';
import { oldDevice } from '../device';
import { voice } from '../voice';

type Category = 'maps' | 'view' | 'traffic' | 'sensors' | 'about';

const CATEGORIES: { id: Category; label: string; icon: IconName }[] = [
  { id: 'maps', label: 'Карты', icon: 'map-outline' },
  { id: 'view', label: 'Вид и звук', icon: 'palette-outline' },
  { id: 'traffic', label: 'Пробки', icon: 'traffic-light-outline' },
  { id: 'sensors', label: 'Датчики', icon: 'radio-tower' },
  { id: 'about', label: 'О приложении', icon: 'information-outline' },
];

export function SettingsSheet({ data, settings, onSettings, onImport, obd, adapters, onScanObd, onConnectObd, onDisconnectObd, onClose, near, learned, onClearLearned, onOpenMaps, onOpenRegions, mapsSummary, onSelfTest }: {
  data: Loaded | null; settings: Settings; onSettings: (s: Settings) => void; onImport: (k: Kind) => void;
  near?: LatLon; learned: { total: number; usable: number }; onClearLearned: () => void;
  onOpenMaps: () => void; onOpenRegions: () => void; mapsSummary: string;
  onSelfTest?: () => { ok: boolean; score: number; issues: string[]; summary: string };
  obd: { s: ObdState; err: string }; adapters: { name: string; address: string }[];
  onScanObd: () => void; onConnectObd: (addr: string) => void; onDisconnectObd: () => void; onClose: () => void;
}) {
  const { wide } = useWide();
  const { bottom } = useInsets();
  const [cat, setCat] = useState<Category>('maps');
  const [key, setKey] = useState(settings.gisKey ?? '');
  const [keySaved, setKeySaved] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const saveGisKey = () => {
    onSettings({ ...settings, gisKey: key.trim(), traffic: settings.traffic ?? true });
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  };

  const resetAllSettings = () => {
    Alert.alert(
      'Сброс настроек',
      'Вы уверены, что хотите сбросить все настройки к значениям по умолчанию?',
      [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Сбросить', style: 'destructive', onPress: () => {
          onSettings({});
          setKey('');
        }},
      ]
    );
  };

  return (
    <View style={[ui.sheet, { maxHeight: '88%' }, wide && [ui.sheetWide, { top: 16, maxHeight: undefined }]]}>
      <View style={ui.grabber} />

      {/* Header & Tabs */}
      <View style={s.headerContainer}>
        <Text style={ui.h2}>Настройки</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tabScroll}>
          {CATEGORIES.map((c) => {
            const active = cat === c.id;
            return (
              <Pressable key={c.id} style={[s.tab, active && s.tabActive]} onPress={() => setCat(c.id)}>
                <Icon name={c.icon} size={18} color={active ? '#fff' : C.sub} />
                <Text style={[s.tabText, active && s.tabTextActive]}>{c.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[s.content, { paddingBottom: Math.max(bottom, 36) }]}>

        {/* CATEGORY: MAPS */}
        {cat === 'maps' && (
          <>
            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}><Icon name="download-outline" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Карты без интернета</Text>
                  <Text style={s.cardSub}>Оффлайн-векторные карты для навигации без сети</Text>
                </View>
              </View>

              <Pressable style={({ pressed }) => [s.bigBanner, { backgroundColor: C.green, marginBottom: sz(10) }, pressed && { opacity: 0.85 }]} onPress={onOpenRegions}>
                <Icon name="map-marker-path" size={26} color="#fff" style={{ marginRight: 12 }} />
                <View style={{ flex: 1 }}>
                  <Text style={s.bigTitle}>Области без интернета</Text>
                  <Text style={s.bigSub}>Карта, маршруты и поиск адресов — без сети и VPN</Text>
                </View>
                <Icon name="chevron-right" size={26} color="#fff" />
              </Pressable>

              <Pressable style={({ pressed }) => [s.bigBanner, pressed && { opacity: 0.85 }]} onPress={onOpenMaps}>
                <Icon name="map-check-outline" size={26} color="#fff" style={{ marginRight: 12 }} />
                <View style={{ flex: 1 }}>
                  <Text style={s.bigTitle}>Скачать карты городов</Text>
                  <Text style={s.bigSub}>{mapsSummary}</Text>
                </View>
                <Icon name="chevron-right" size={26} color="#fff" />
              </Pressable>

              <Text style={[ui.sub, { marginTop: 12, marginBottom: 6 }]}>Подкачка карты и данных в пути (на ~60 км вперед):</Text>
              <View style={s.seg}>
                {([['all', 'Карту и вышки', 'download-outline'], ['cells', 'Только вышки', 'radio-tower'], ['off', 'Ничего', 'web']] as const).map(([v, label, icon]) => {
                  const sel = (settings.prefetch ?? 'all') === v;
                  return (
                    <Pressable key={v} style={[s.segBtn, sel && s.segSel]} onPress={() => onSettings({ ...settings, prefetch: v })}>
                      <Icon name={icon} size={18} color={sel ? '#fff' : C.text} />
                      <Text style={[s.segText, sel && { color: '#fff' }]}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}><Icon name="folder-download-outline" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Пользовательские файлы</Text>
                  <Text style={s.cardSub}>Загрузите свои файлы карт, маршрутов или вышек</Text>
                </View>
              </View>
              <Row title="Векторная карта (.pmtiles)" sub={data?.mapUri ? data.info.map : 'Онлайн-карта'} onPress={() => onImport('map')} right={<Text style={s.link}>Выбрать</Text>} />
              <Row title="Файл маршрута (.gpx)" sub={data?.info.route ?? 'Не загружен'} onPress={() => onImport('route')} right={<Text style={s.link}>Выбрать</Text>} />
              <Row title="База вышек (cells.json)" sub={data?.info.cells ?? 'Не загружена'} onPress={() => onImport('cells')} right={<Text style={s.link}>Выбрать</Text>} />
            </View>
          </>
        )}

        {/* CATEGORY: VIEW & AUDIO */}
        {cat === 'view' && (
          <>
            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}><Icon name="palette-outline" size={20} color={C.blue} /></View>

                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Тема оформления</Text>
                  <Text style={s.cardSub}>Выбор цветовой схемы интерфейса</Text>
                </View>
              </View>

              <View style={s.seg}>
                {([['auto', 'Системная', 'cellphone'], ['light', 'Светлая', 'white-balance-sunny'], ['dark', 'Тёмная', 'weather-night']] as const).map(([v, label, icon]) => {
                  const sel = (settings.theme ?? 'auto') === v;
                  return (
                    <Pressable key={v} style={[s.segBtn, sel && s.segSel]} onPress={() => onSettings({ ...settings, theme: v })}>
                      <Icon name={icon} size={20} color={sel ? '#fff' : C.text} />
                      <Text style={[s.segText, sel && { color: '#fff' }]}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}><Icon name="speedometer" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Лёгкий режим</Text>
                  <Text style={s.cardSub}>Для старых и слабых телефонов: без 3D-домов и анимаций, карта проще{oldDevice ? ' · ваш телефон определён как старый' : ''}</Text>
                </View>
              </View>
              <View style={s.seg}>
                {([['auto', 'Авто', 'auto-fix'], ['on', 'Вкл', 'leaf'], ['off', 'Выкл', 'rocket-launch-outline']] as const).map(([v, label, icon]) => {
                  const sel = (settings.lite ?? 'auto') === v;
                  return (
                    <Pressable key={v} style={[s.segBtn, sel && s.segSel]} onPress={() => onSettings({ ...settings, lite: v, view3d: undefined })}>
                      <Icon name={icon} size={20} color={sel ? '#fff' : C.text} />
                      <Text style={[s.segText, sel && { color: '#fff' }]}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}><Icon name="volume-high" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Звуковое сопровождение</Text>
                  <Text style={s.cardSub}>Голосовые подсказки во время движения</Text>
                </View>
              </View>

              <View style={[ui.row, { paddingVertical: 8 }]}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={ui.body}>Голосовые подсказки</Text>
                  <Text style={ui.sub}>Озвучивание маневров, камер, дорожных знаков и состояния GPS на русском языке.</Text>
                </View>
                <Switch value={settings.voice !== false} onValueChange={(v) => {
                  onSettings({ ...settings, voice: v });
                  voice.enabled = v;
                }} />
              </View>
            </View>
          </>
        )}

        {/* CATEGORY: TRAFFIC */}
        {cat === 'traffic' && (
          <>
            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}><Icon name="traffic-light-outline" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Пробки 2ГИС</Text>
                  <Text style={s.cardSub}>Расчёт загруженности дорог по API 2ГИС</Text>
                </View>
                {settings.gisKey ? (
                  <View style={[s.badge, { backgroundColor: '#e6f4ea' }]}><Text style={[s.badgeText, { color: C.green }]}>Ключ активен ✓</Text></View>
                ) : (
                  <View style={[s.badge, { backgroundColor: C.chip }]}><Text style={[s.badgeText, { color: C.sub }]}>Не настроено</Text></View>
                )}
              </View>

              <Text style={[ui.sub, { marginBottom: 8, lineHeight: 18 }]}>
                Для показа пробок укажите ваш бесплатный ключ Routing API с platform.2gis.ru. Данные обновляются каждые несколько минут при подключении к сети.
              </Text>

              <TextInput
                style={s.input}
                value={key}
                onChangeText={setKey}
                placeholder="Ключ API 2ГИС"
                placeholderTextColor={C.hint}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 10 }}>
                <Button small kind="primary" text={keySaved ? 'Сохранено ✓' : 'Сохранить ключ'} onPress={saveGisKey} style={{ flex: 1 }} />
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={[ui.body, { marginRight: 8, fontSize: 13 }]}>Включить</Text>
                  <Switch value={!!settings.traffic} onValueChange={(v) => onSettings({ ...settings, gisKey: key.trim(), traffic: v })} />
                </View>
              </View>
            </View>

            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}><Icon name="web" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Дополнительные веб-слои</Text>
                  <Text style={s.cardSub}>Экспериментальные онлайн-сервисы трафика</Text>
                </View>
              </View>

              <Text style={[ui.sub, { marginBottom: 12, lineHeight: 18 }]}>
                Загрузка данных из публичных веб-источников при наличии подключения к интернету. При отсутствии сети навигатор продолжит работу по оффлайн-картам.
              </Text>

              <View style={s.settingRow}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Text style={ui.body}>Waze (события и ДТП)</Text>
                  <Text style={ui.sub}>Отображение предупреждений и перекрытий на маршруте.</Text>
                </View>
                <Switch value={!!settings.waze} onValueChange={(v) => onSettings({ ...settings, waze: v })} />
              </View>

              <View style={s.settingRow}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Text style={ui.body}>Google (слой пробок)</Text>
                  <Text style={ui.sub}>Визуальный слой загруженности дорог поверх карты.</Text>
                </View>
                <Switch value={!!settings.gTraffic} onValueChange={(v) => onSettings({ ...settings, gTraffic: v })} />
              </View>

              <View style={s.settingRow}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Text style={ui.body}>Яндекс (анализ линии)</Text>
                  <Text style={ui.sub}>Анализ цвета дорог под линией маршрута для оценки задержек.</Text>
                </View>
                <Switch value={!!settings.yandex} onValueChange={(v) => onSettings({ ...settings, yandex: v })} />
              </View>

              {!!settings.yandex && (
                <TextInput
                  style={[s.input, { marginTop: 10, fontSize: 12 }]}
                  value={settings.yandexUrl ?? ''}
                  placeholder="Свой URL тайлов: …x={x}&y={y}&z={z}&tm={tm}"
                  placeholderTextColor={C.hint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(t) => onSettings({ ...settings, yandexUrl: t.trim() || undefined })}
                />
              )}
            </View>
          </>
        )}

        {/* CATEGORY: SENSORS */}
        {cat === 'sensors' && (
          <>
            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}><Icon name="radio-tower" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Позиционирование по вышкам</Text>
                  <Text style={s.cardSub}>Автономный поиск координат при подавлении GPS</Text>
                </View>
              </View>

              <Text style={[ui.sub, { marginBottom: 10, lineHeight: 18 }]}>
                При отсутствии честного GPS-сигнала приложение использует запомненные ориентиры сотовых вышек и Wi-Fi для определения положения.
              </Text>

              <Row
                title="Сохранённая база ориентации"
                sub={`${learned.total} сигналов запомнено (${learned.usable} активных)`}
                right={<Text style={[s.link, { color: C.red }]} onPress={onClearLearned}>Очистить</Text>}
              />
            </View>

            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}><Icon name="bluetooth" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>OBD2 Bluetooth-адаптер</Text>
                  <Text style={s.cardSub}>Точная скорость автомобиля с бортового компьютера</Text>
                </View>
                {obd.s === 'on' ? (
                  <View style={[s.badge, { backgroundColor: '#e6f4ea' }]}><Text style={[s.badgeText, { color: C.green }]}>Подключено ✓</Text></View>
                ) : (
                  <View style={[s.badge, { backgroundColor: C.chip }]}><Text style={[s.badgeText, { color: C.sub }]}>Отключено</Text></View>
                )}
              </View>

              <Text style={[ui.sub, { marginBottom: 10, lineHeight: 18 }]}>
                Предварительно выполните сопряжение OBD2-адаптера в настройках Bluetooth устройства (PIN 1234 или 0000).
              </Text>

              {obd.s === 'on' ? (
                <Button small kind="secondary" text="Отключить OBD" onPress={onDisconnectObd} />
              ) : (
                <>
                  {adapters.map((a) => <Row key={a.address} title={a.name} sub={a.address} onPress={() => onConnectObd(a.address)} />)}
                  <View style={{ flexDirection: 'row', marginTop: 8 }}>
                    <Button small kind="secondary" text={adapters.length ? 'Обновить список Bluetooth' : 'Поиск OBD2 адаптеров'} onPress={onScanObd} />
                  </View>
                </>
              )}
              {!!obd.err && <Text style={[ui.sub, { color: C.red, marginTop: 8 }]}>{obd.err}</Text>}
            </View>
          </>
        )}

        {/* CATEGORY: ABOUT */}
        {cat === 'about' && (
          <>
            {onSelfTest && (
              <View style={s.card}>
                <View style={s.cardHeader}>
                  <View style={s.cardIcon}><Icon name="shield-check-outline" size={20} color={C.blue} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.cardTitle}>Диагностика перед поездкой</Text>
                    <Text style={s.cardSub}>Проверка датчиков и сигналов перед выездом</Text>
                  </View>
                </View>

                <Pressable
                  style={({ pressed }) => [s.bigBanner, { backgroundColor: C.blue }, pressed && { opacity: 0.85 }]}
                  onPress={() => {
                    const res = onSelfTest();
                    setTestResult(`Оценка: ${res.score}/100. ${res.summary}`);
                  }}
                >
                  <Icon name="checkbox-marked-circle-outline" size={26} color="#fff" style={{ marginRight: 12 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.bigTitle}>Проверить готовность</Text>
                    <Text style={s.bigSub}>{testResult ?? 'Тест GPS, вышек и сенсоров (30 сек)'}</Text>
                  </View>
                </Pressable>
              </View>
            )}

            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}><Icon name="information-outline" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>О приложении</Text>
                  <Text style={s.cardSub}>Тропа Навигатор — Версия 0.1.0</Text>
                </View>
              </View>

              <View style={s.aboutItem}>
                <Icon name="shield-lock-outline" size={20} color={C.blue} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={ui.body}>Защита конфиденциальности</Text>
                  <Text style={ui.sub}>Все данные о локациях, сотовых вышках и маршрутах остаются строго на вашем устройстве.</Text>
                </View>
              </View>

              <View style={s.aboutItem}>
                <Icon name="code-tags" size={20} color={C.blue} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={ui.body}>Компоненты Open-Source</Text>
                  <Text style={ui.sub}>MapLibre GL, Protomaps, OpenStreetMap, OpenCelliD</Text>
                </View>
              </View>

              <View style={{ marginTop: 12 }}>
                <Button small kind="danger" text="Сбросить все настройки" onPress={resetAllSettings} />
              </View>
            </View>
          </>
        )}

        <Pressable onPress={onClose} style={s.closeBtn}>
          <Text style={s.closeBtnText}>Закрыть</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const s = themed(() => ({
  headerContainer: { paddingBottom: sz(10), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  tabScroll: { flexDirection: 'row', gap: sz(6), paddingTop: sz(10) },
  tab: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: sz(12), paddingVertical: sz(8), borderRadius: sz(20), backgroundColor: C.chip },
  tabActive: { backgroundColor: C.blue },
  tabText: { fontSize: sz(13), fontWeight: '600', color: C.sub, marginLeft: sz(6) },
  tabTextActive: { color: '#fff' },
  content: { paddingTop: sz(12), paddingBottom: sz(20), gap: sz(12) },
  card: { backgroundColor: C.cardAlt, borderRadius: sz(18), padding: sz(14), borderWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: sz(10) },
  cardIcon: { width: sz(34), height: sz(34), borderRadius: sz(10), backgroundColor: C.blueSoft, alignItems: 'center', justifyContent: 'center', marginRight: sz(10) },
  cardTitle: { fontSize: sz(16), fontWeight: '700', color: C.text },
  cardSub: { fontSize: sz(12), color: C.sub, marginTop: 1 },
  badge: { paddingHorizontal: sz(8), paddingVertical: sz(4), borderRadius: sz(12) },
  badgeText: { fontSize: sz(11), fontWeight: '700' },
  bigBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.blue, borderRadius: sz(16), padding: sz(14), marginTop: sz(4) },
  bigTitle: { color: '#fff', fontSize: sz(15), fontWeight: '700' },
  bigSub: { color: '#dbe6ff', fontSize: sz(12), marginTop: 2 },
  seg: { flexDirection: 'row', gap: sz(8), marginTop: sz(6) },
  segBtn: { flex: 1, alignItems: 'center', paddingVertical: sz(10), borderRadius: sz(12), backgroundColor: C.chip },
  segSel: { backgroundColor: C.blue },
  segText: { fontSize: sz(12), fontWeight: '600', color: C.text, marginTop: sz(4) },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: sz(8), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  input: { backgroundColor: C.chip, borderRadius: sz(12), paddingHorizontal: sz(12), height: sz(44), fontSize: sz(14), color: C.text, marginTop: sz(4) },
  link: { color: C.blue, fontWeight: '600', fontSize: sz(13) },
  aboutItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: sz(8), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  closeBtn: { marginTop: sz(12), paddingVertical: sz(12), alignItems: 'center', justifyContent: 'center', borderRadius: sz(14), backgroundColor: C.chip },
  closeBtnText: { fontSize: sz(15), fontWeight: '700', color: C.text },
}));
