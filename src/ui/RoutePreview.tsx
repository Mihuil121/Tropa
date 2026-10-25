// Выбор транспорта с временем на каждом — как в Яндекс Картах / 2ГИС.

import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MODES, fmtClock, fmtDistance, fmtDuration, type PlannedRoute, type Place, type TravelMode } from '../online';
import { Button } from './components';
import { WeatherRoute } from './WeatherUI';
import type { WeatherAt } from '../weather';
import { Icon, type IconName } from './Icon';
import { AnimatedIcon } from './AnimatedIcon';
import { C, compact, shadow, ui, themed, useWide, useInsets, PANEL_W, sz } from './theme';

import type { Trip } from '../trips';

export type Plans = Partial<Record<TravelMode, PlannedRoute | string>>;

export function RoutePreview({ dest, plans, loading, mode, onMode, onGo, onClose, trafficNote, weather, extra, onPrepareOffline, onRetry, hasGisKey, trip, onRemoveStop }: {
  dest: Place; plans: Plans; loading: boolean; mode: TravelMode; trafficNote?: string; weather?: WeatherAt[] | null; extra?: ReactNode;
  onMode: (m: TravelMode) => void; onGo: () => void; onClose: () => void; onPrepareOffline?: (r: PlannedRoute) => void;
  onRetry?: () => void; hasGisKey?: boolean; trip?: Trip | null; onRemoveStop?: (idx: number) => void;
}) {
  const { wide, height } = useWide();
  const { top } = useInsets();
  // Нижняя панель не должна закрывать весь экран: остальное — прокруткой
  const bodyMax = Math.max(160, height - top - sz(compact ? 300 : 340));
  const [savingOffline, setSavingOffline] = useState(false);
  const [savedOffline, setSavedOffline] = useState(false);
  const cur = plans[mode];
  const ok = typeof cur === 'object' ? cur : null;
  const errText = typeof cur === 'string' ? cur : '';
  const blocked = /VPN|2ГИС|недоступ|нет ответа|не отвечал|молчащ|Failed to fetch|Network request failed|таймаут|abort/i.test(errText);
  return (
    <>
      {/* Откуда → куда, как в приложениях такси */}
      <View style={[ui.card, s.top, { top }, wide && { right: undefined, width: PANEL_W }]}>
        <Pressable onPress={onClose} hitSlop={12} style={{ marginRight: 10 }}><Icon name="arrow-left" size={26} color={C.text} /></Pressable>
        <View style={s.dots}>
          <View style={[s.dot, { borderColor: C.text }]} />
          <View style={s.dotLine} />
          <View style={[s.dot, { borderColor: C.blue, backgroundColor: C.blue }]} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.label}>ОТКУДА</Text>
          <Text style={s.from} numberOfLines={1}>Моё местоположение</Text>
          <View style={s.sep} />
          <Text style={s.label}>КУДА</Text>
          <Text style={s.to} numberOfLines={1}>{dest.name}</Text>
        </View>
      </View>

      <View style={[ui.sheet, wide && ui.sheetWide]}>
        <View style={ui.grabber} />
        <View style={s.tabs}>
          {MODES.map((m) => {
            const p = plans[m.id];
            const sel = m.id === mode;
            const isFar = typeof p === 'string' && (p.includes('distance') || p.includes('далеко'));
            return (
              <Pressable key={m.id} onPress={() => onMode(m.id)} style={[s.tab, sel && s.tabSel]}>
                <Icon name={m.icon} size={sz(28)} color={sel ? '#fff' : C.text} />
                <Text style={[s.tabLabel, sel && { color: '#dbe6ff' }]} numberOfLines={1}>{m.label.toUpperCase()}</Text>
                {loading && p === undefined ? (
                  <ActivityIndicator size="small" color={sel ? '#fff' : C.sub} style={{ marginTop: 6 }} />
                ) : (
                  <>
                    <Text style={[s.tabTime, sel && { color: '#fff' }]} numberOfLines={1}>
                      {typeof p === 'object' ? fmtDuration(p.timeS) : isFar ? 'далеко' : '—'}
                    </Text>
                    <Text style={[s.tabDist, sel && { color: '#dbe6ff' }]} numberOfLines={1}>
                      {typeof p === 'object' ? fmtDistance(p.lengthM) : ' '}
                    </Text>
                  </>
                )}
              </Pressable>
            );
          })}
        </View>

        <ScrollView style={{ maxHeight: bodyMax }} showsVerticalScrollIndicator={false} bounces={false}>
        {ok ? (
          <View style={s.summary}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={s.bigTime} numberOfLines={1} adjustsFontSizeToFit>{fmtDuration(ok.timeS)}</Text>
                  <Icon name="arrow-right" size={22} color={C.sub} style={{ marginHorizontal: 6 }} />
                  <Text style={s.arrive} numberOfLines={1} adjustsFontSizeToFit>{fmtClock(Date.now() + ok.timeS * 1000)}</Text>
                </View>
                <Text style={[ui.sub, { marginTop: 2 }]}>
                  {fmtDistance(ok.lengthM)} · {mode === 'car' ? (trafficNote || 'без учёта пробок') : mode === 'scooter' ? 'по тротуарам и дорожкам' : 'по тротуарам'}
                </Text>
              </View>
              <Pressable onPress={onGo} style={({ pressed }) => [s.go, !ok && { opacity: 0.5 }, pressed && { transform: [{ scale: 0.97 }] }]}>
                <Icon name="navigation-variant" size={20} color="#fff" style={{ marginRight: 6 }} />
                <Text style={s.goText}>В путь</Text>
              </Pressable>
            </View>
            <View style={s.facts}>
              {ok.maneuvers?.length ? <Fact icon="directions-fork" text={`поворотов: ${ok.maneuvers.filter((m) => m.type > 3 && ![4, 5, 6].includes(m.type)).length}`} /> : null}
              {mode === 'car' && ok.limits ? <Fact icon="speedometer" text={ok.limits.length ? `знаки: ${[...new Set(ok.limits.map((l) => l.kmh))].sort((a, b) => a - b).join('/')} км/ч` : 'знаков нет'} /> : null}
              {ok.seaCrossing ? <Fact icon="water" text="Есть водный участок (паром / прямая через море)" /> : null}
              {ok.onDevice ? <Fact icon="cellphone-check" text="Построено в телефоне — без интернета" /> : null}
              {ok.offline ? <Fact icon="map-marker" text={ok.offlineGraph ? 'Построено офлайн — по сохранённым дорогам' : 'Построено офлайн — по прямой'} /> : null}
              {ok.stops?.map((st, i) => (
                <View key={i} style={s.fact}>
                  <Icon name="map-marker-check" size={16} color={C.blue} style={{ marginRight: 5 }} />
                  <Text style={s.factText}>Остановка: {st.name}</Text>
                  {onRemoveStop && (
                    <Pressable onPress={() => onRemoveStop(i)} hitSlop={8} style={{ marginLeft: 6 }}>
                      <Icon name="close" size={14} color={C.sub} />
                    </Pressable>
                  )}
                </View>
              ))}
            </View>
            {ok.offline && !ok.offlineGraph && (
              <View style={s.seaWarn}>
                <Icon name="alert-outline" size={16} color={C.amber} style={{ marginRight: 6 }} />
                <Text style={s.seaWarnText}>Внимание: нет сети или VPN. Маршрут построен по прямой офлайн (без учёта дорог и зданий).</Text>
              </View>
            )}
            {ok.seaCrossing && (
              <View style={s.seaWarn}>
                <Icon name="alert-circle-outline" size={16} color={C.amber} style={{ marginRight: 6 }} />
                <Text style={s.seaWarnText}>Часть маршрута проходит через воду — будьте осторожны, возможен только паром.</Text>
              </View>
            )}
            <WeatherRoute items={weather ?? null} />
            {mode === 'car' && extra ? <View style={{ marginTop: 10 }}>{extra}</View> : null}
            {onPrepareOffline && ok ? (
              <Pressable
                onPress={() => {
                  if (trip?.status === 'downloading' || trip?.status === 'ready') return;
                  onPrepareOffline(ok);
                }}
                style={({ pressed }) => [
                  s.offlinePlanBtn,
                  trip?.status === 'ready' && { backgroundColor: C.blueSoft, borderColor: C.blue },
                  trip?.status === 'error' && { borderColor: C.red },
                  pressed && { opacity: 0.8 },
                ]}
              >
                {trip?.status === 'downloading' || trip?.status === 'queued' ? (
                  <>
                    <AnimatedIcon name="download" size={24} color={C.blue} loop style={{ marginRight: 8 }} />
                    <Text style={s.offlinePlanText}>Скачивается {Math.floor(trip.totalPct)}%…</Text>
                  </>
                ) : trip?.status === 'ready' ? (
                  <>
                    <AnimatedIcon name="checkmark" size={24} color={C.blue} style={{ marginRight: 8 }} />
                    <Text style={s.offlinePlanText}>Скачано ✓ ({trip.mb ? `${trip.mb} МБ` : 'офлайн'})</Text>
                  </>
                ) : trip?.status === 'error' ? (
                  <>
                    <Icon name="alert-circle-outline" size={20} color={C.red} style={{ marginRight: 8 }} />
                    <Text style={[s.offlinePlanText, { color: C.red }]}>
                      {trip.error || 'Ошибка загрузки'} — Повторить
                    </Text>
                  </>
                ) : (
                  <>
                    <Icon name="download" size={20} color={C.blue} style={{ marginRight: 8 }} />
                    <Text style={s.offlinePlanText}>Запланировать поездку без интернета (скачать карту и вышки)</Text>
                  </>
                )}
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={s.blocked}>
            <View style={s.blockedIcon}>
              <Icon name={loading ? "map-marker" : "map-marker-off"} size={28} color={loading ? C.blue : C.red} />
            </View>
            <Text style={s.blockedTitle}>
              {loading ? 'Прокладываем маршрут…' : 'Не получилось построить маршрут'}
            </Text>
            {errText && <Text style={s.blockedSub} numberOfLines={3}>{`Причина: ${errText}`}</Text>}
            {!loading && blocked && !hasGisKey && (
              <Text style={[s.blockedHint, { color: C.redText }]}>
                Серверы маршрутов не ответили (из России без VPN так бывает). Нажмите «Попробовать снова» — с VPN или в другой сети. Чтобы маршрут строился без интернета вообще, скачайте свою область: Настройки → Области без интернета.
              </Text>
            )}
            {!loading && blocked && hasGisKey && (
              <Text style={[s.blockedHint, { color: C.redText }]}>
                Ключ 2ГИС задан, но сервер не ответил. Проверьте интернет или попробуйте снова.
              </Text>
            )}
            {!loading && !blocked && errText && (
              <Text style={[s.blockedHint, { color: C.redText }]}>{errText}</Text>
            )}
            {!loading && onRetry && (
              <Pressable onPress={onRetry} style={({ pressed }) => [s.retry, pressed && { opacity: 0.8 }]}>
                <Icon name="refresh" size={18} color={C.blue} style={{ marginRight: 6 }} />
                <Text style={s.retryText}>Попробовать снова</Text>
              </Pressable>
            )}
          </View>
        )}

        </ScrollView>
        {!compact && <Text style={s.note}>Маршрут и знаки скорости сохранятся в телефоне и будут работать без интернета.</Text>}
      </View>
    </>
  );
}

function Fact({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={s.fact}>
      <Icon name={icon} size={16} color={C.blue} style={{ marginRight: 5 }} />
      <Text style={s.factText}>{text}</Text>
    </View>
  );
}

const s = themed(() => ({
  summary: { marginTop: sz(14), backgroundColor: C.cardAlt, borderRadius: sz(18), padding: sz(14) },
  bigTime: { fontSize: sz(24), fontWeight: '800', color: C.text, flexShrink: 1 },
  arrive: { fontSize: sz(24), fontWeight: '500', color: C.sub },
  go: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.green, borderRadius: sz(14), paddingHorizontal: sz(18), paddingVertical: sz(13), marginLeft: sz(10) },
  goText: { color: '#fff', fontSize: sz(17), fontWeight: '800' },
  facts: { flexDirection: 'row', flexWrap: 'wrap', marginTop: sz(10), gap: sz(8) },
  fact: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.chip, borderRadius: sz(12), paddingHorizontal: sz(10), paddingVertical: sz(6) },
  factText: { fontSize: sz(13), color: C.text },
  offlinePlanBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: C.chip, borderRadius: sz(14), padding: sz(12), marginTop: sz(12), borderWidth: 1, borderColor: C.blue },
  offlinePlanText: { fontSize: sz(13), fontWeight: '700', color: C.blue, flexShrink: 1 },
  top: { position: 'absolute', top: sz(40), left: sz(12), right: sz(12), flexDirection: 'row', alignItems: 'center', padding: sz(14) },
  back: { fontSize: sz(24), color: C.text, marginRight: sz(10) },
  dots: { width: sz(16), alignItems: 'center', marginRight: sz(10) },
  dot: { width: sz(12), height: sz(12), borderRadius: sz(6), borderWidth: 3, backgroundColor: C.card },
  dotLine: { width: 2, height: sz(30), backgroundColor: C.line, marginVertical: sz(3) },
  label: { fontSize: sz(10), color: C.hint, fontWeight: '700', letterSpacing: 0.5 },
  from: { fontSize: sz(15), color: C.text, marginTop: 1 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginVertical: sz(7) },
  to: { fontSize: sz(16), color: C.text, fontWeight: '700', marginTop: 1 },
  tabs: { flexDirection: 'row', gap: sz(8) },
  tab: { flex: 1, backgroundColor: C.chip, borderRadius: sz(16), paddingVertical: sz(10), paddingHorizontal: sz(10) },
  tabSel: { backgroundColor: C.blue },
  tabIcon: { fontSize: sz(26) },
  tabLabel: { fontSize: sz(10), fontWeight: '700', color: C.sub, marginTop: sz(4), letterSpacing: 0.5 },
  tabTime: { fontSize: sz(17), fontWeight: '800', color: C.text, marginTop: 2 },
  tabDist: { fontSize: sz(12), color: C.sub },
  dist: { fontSize: sz(15), fontWeight: '400', color: C.sub },
  note: { fontSize: sz(12), color: C.hint, marginTop: sz(10), textAlign: 'center' },
  retry: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: sz(12), backgroundColor: C.blueSoft, borderRadius: sz(12), paddingHorizontal: sz(12), paddingVertical: sz(8) },
  retryText: { fontSize: sz(14), fontWeight: '700', color: C.blue },
  blocked: { marginTop: sz(14), alignItems: 'center', padding: sz(14), backgroundColor: C.cardAlt, borderRadius: sz(18), ...shadow },
  blockedIcon: { width: sz(56), height: sz(56), borderRadius: sz(28), backgroundColor: C.redSoft, alignItems: 'center', justifyContent: 'center', marginBottom: sz(10) },
  blockedTitle: { fontSize: sz(17), fontWeight: '800', color: C.text, marginBottom: sz(4) },
  blockedSub: { fontSize: sz(13), color: C.sub, textAlign: 'center', marginBottom: sz(8) },
  blockedHint: { fontSize: sz(13), color: C.text, textAlign: 'center', marginBottom: sz(10), lineHeight: sz(20) },
  seaWarn: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.warnSoft, borderRadius: sz(12), paddingHorizontal: sz(10), paddingVertical: sz(7), marginTop: sz(8) },
  seaWarnText: { fontSize: sz(13), color: C.warnText },
}));
