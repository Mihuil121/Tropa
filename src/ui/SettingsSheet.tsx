// Настройки: карт, визуального стиля, трафика, датчиков и сведений о приложении.

import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { Kind, Loaded, Settings } from '../data';
import type { ObdState } from '../obdLink';
import { Button, Row } from './components';
import { Icon, type IconName } from './Icon';
import type { LatLon } from '../core/geo';
import { C, ui, themed, useWide, useInsets, sz } from './theme';
import { oldDevice } from '../device';
import { voice } from '../voice';
import { startOperaProxy, stopOperaProxy, subscribeOperaProxy, type OperaProxyStatus } from '../../modules/opera-proxy';

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
  const [operaStatus, setOperaStatus] = useState<OperaProxyStatus>({ state: 'stopped' });

  useEffect(() => {
    return subscribeOperaProxy((st) => setOperaStatus(st));
  }, []);

  const saveGisKey = () => {
    onSettings({ ...settings, gisKey: key.trim(), traffic: true });
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 3000);
  };

  const resetAllSettings = () => {
    Alert.alert(
      'Сбросить все настройки?',
      'Приложение вернется к исходным параметрам.',
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
                <View style={s.cardIcon}><Icon name="shield-key-outline" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Обход блокировок (Opera VPN)</Text>
                  <Text style={s.cardSub}>Локальный прокси для загрузки карт и зеркал</Text>
                </View>
                <Switch
                  value={!!settings.operaProxy}
                  onValueChange={(v) => {
                    onSettings({ ...settings, operaProxy: v });
                    if (v) {
                      startOperaProxy({ country: settings.operaCountry || 'EU' });
                    } else {
                      stopOperaProxy();
                    }
                  }}
                />
              </View>

              <Text style={[ui.sub, { marginBottom: 10, lineHeight: 18 }]}>
                Когда включено, запросы карт, маршрутов и заправок идут через серверы Opera. Позиция по GPS/вышкам определяется отдельно и через прокси не идёт. Координаты в запросах к картам видны Opera.
              </Text>

              {!!settings.operaProxy && (
                <View style={{ marginTop: 6 }}>
                  <Text style={[ui.sub, { fontWeight: '700', marginBottom: 6 }]}>Выбор страны прокси:</Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                    {(['EU', 'AS', 'AM'] as const).map((c) => (
                      <Pressable
                        key={c}
                        onPress={() => {
                          const nextCountry = c;
                          onSettings({ ...settings, operaCountry: nextCountry });
                          startOperaProxy({ country: nextCountry });
                        }}
                        style={[s.fchip, (settings.operaCountry || 'EU') === c && { backgroundColor: C.blue }]}
                      >
                        <Text style={[s.fchipText, (settings.operaCountry || 'EU') === c && { color: '#fff' }]}>
                          {c === 'EU' ? 'Европа (EU)' : c === 'AS' ? 'Азия (AS)' : 'Америка (AM)'}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={[ui.sub, { color: operaStatus.state === 'ready' ? C.green : operaStatus.state === 'failed' ? C.redText : C.blue, fontWeight: '600' }]}>
                    Статус: {operaStatus.state === 'ready' ? `Готов (порт ${operaStatus.port})` : operaStatus.state === 'starting' ? 'Запускается…' : operaStatus.state === 'failed' ? `Ошибка: ${operaStatus.lastError || 'сбой старта'}` : 'Остановлен'}
                  </Text>
                </View>
              )}
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
                <View style={s.cardIcon}><Icon name="volume-high" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Голосовые подсказки</Text>
                  <Text style={s.cardSub}>Озвучка маневров на русском языке</Text>
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
                  <Text style={s.cardTitle}>Датчики автомобиля (OBD-II)</Text>
                  <Text style={s.cardSub}>Чтение скорости и оборотов через ELM327 Bluetooth</Text>
                </View>
                {adapters.length > 0 && <View style={[s.badge, { backgroundColor: '#e6f4ea' }]}><Text style={[s.badgeText, { color: C.green }]}>Найдено {adapters.length}</Text></View>}
              </View>

              <Text style={[ui.sub, { marginBottom: 10, lineHeight: 18 }]}>
                {obd.s === 'on' ? 'Адаптер подключен ✓' : obd.s === 'connecting' ? 'Подключаемся…' : 'Подключите ELM327 для чтения скорости в тоннелях и при глушении GPS.'}
              </Text>

              {obd.s === 'on' ? (
                <Button small kind="danger" text="Отключить OBD" onPress={onDisconnectObd} />
              ) : (
                <View style={{ gap: 8 }}>
                  <Button small kind="primary" text="Найти адаптеры" onPress={onScanObd} />
                  {adapters.map((a) => (
                    <Pressable key={a.address} style={s.segBtn} onPress={() => onConnectObd(a.address)}>
                      <Text style={{ fontWeight: '700', color: C.text }}>{a.name}</Text>
                      <Text style={{ fontSize: 11, color: C.sub }}>{a.address}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}><Icon name="speedometer" size={20} color={C.blue} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>Самодиагностика</Text>
                  <Text style={s.cardSub}>Проверка датчиков и работы офлайн-ядра</Text>
                </View>
              </View>

              <Text style={[ui.sub, { marginBottom: 12, lineHeight: 18 }]}>
                Запустите тест для оценки точности позиционирования, работы гироскопа и доступности спутников.
              </Text>

              {onSelfTest && (
                <Pressable
                  style={({ pressed }) => [s.bigBanner, pressed && { opacity: 0.85 }]}
                  onPress={() => {
                    const r = onSelfTest();
                    setTestResult(`${r.score}% — ${r.summary}`);
                  }}
                >
                  <Icon name="check-decagram" size={26} color="#fff" style={{ marginRight: 12 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.bigTitle}>Проверить готовность</Text>
                    <Text style={s.bigSub}>{testResult ?? 'Тест GPS, вышек и сенсоров (30 сек)'}</Text>
                  </View>
                </Pressable>
              )}
            </View>
          </>
        )}

        {/* CATEGORY: ABOUT */}
        {cat === 'about' && (
          <>
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
  fchip: { backgroundColor: C.chip, borderRadius: sz(14), paddingHorizontal: sz(12), paddingVertical: sz(6) },
  fchipText: { fontSize: sz(12), fontWeight: '700', color: C.text },
  closeBtn: { marginTop: sz(10), paddingVertical: sz(12), alignItems: 'center', backgroundColor: C.chip, borderRadius: sz(14) },
  closeBtnText: { fontSize: sz(15), fontWeight: '700', color: C.text },
  aboutItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: sz(8), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  link: { color: C.blue, fontWeight: '700', fontSize: sz(13) },
  input: { backgroundColor: C.chip, borderRadius: sz(12), paddingHorizontal: sz(12), height: sz(42), color: C.text, fontSize: sz(14) },
}));
