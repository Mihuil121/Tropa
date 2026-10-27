// Экран ведения — микс навигаторов:
//   сверху чёрная карточка манёвра (большая стрелка, «820 м», куда поворачиваем);
//   слева под ней знак ограничения скорости и ваша скорость (краснеет при превышении);
//   снизу компактная полоса: осталось км · мин · прибытие + полоска пройденного пути.
// Когда GPS заглушён или подменён — понятная плашка и кнопки помощи.

import { useState, useEffect, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NavState } from '../core/engine';
import { fmtClock, fmtDistance, fmtDuration, type PlannedRoute } from '../online';
import { Icon, maneuverIcon } from './Icon';
import { WeatherRoute } from './WeatherUI';
import type { WeatherAt } from '../weather';
import { Button, Chip, SpeedSign } from './components';
import { C, GPS_LABEL, compact, shadow, themed, useWide, PANEL_W, sz } from './theme';
import { voice } from '../voice';

export function ManeuverCard({ nav, hasRoute }: { nav: NavState | null; hasRoute: boolean }) {
  const { wide } = useWide();
  if (!hasRoute) return null;
  const n = nav?.next;
  const arrived = nav?.routeLeft != null && nav.routeLeft < 40;
  const [dNum, dUnit] = n ? splitDist(n.dist) : ['', ''];

  useEffect(() => {
    if (arrived) {
      voice.speak('Вы прибыли в точку назначения', true);
    } else if (n && n.dist > 0 && n.text) {
      voice.announceManeuver(n.dist, n.text);
    }
  }, [arrived, n?.dist, n?.text, n?.type]);
  return (
    <View style={[s.man, wide && { right: undefined, width: PANEL_W }]}>
      <View style={s.arrowBox}>
        <Icon name={arrived ? 'flag-checkered' : maneuverIcon(n?.type)} size={sz(44)} color="#fff" />
      </View>
      <View style={{ flex: 1 }}>
        {arrived ? (
          <Text style={s.manDist}>Вы на месте</Text>
        ) : n ? (
          <>
            <Text style={s.manDist} numberOfLines={1} adjustsFontSizeToFit>{dNum}<Text style={s.manUnit}> {dUnit}</Text></Text>
            <Text style={s.manText} numberOfLines={compact ? 1 : 2}>{n.text}</Text>
          </>
        ) : (
          <Text style={s.manText}>Прямо по маршруту</Text>
        )}
      </View>
    </View>
  );
}

function splitDist(m: number): [string, string] {
  const t = fmtDistance(m);
  const i = t.lastIndexOf(' ');
  return [t.slice(0, i), t.slice(i + 1)];
}

/** Знак скорости слева под карточкой манёвра (и на карте без маршрута — внизу слева). */
export function SpeedOverlay({ nav, limit, top }: { nav: NavState | null; limit: number | null; top: number }) {
  if (!nav?.ready) return null;
  const vehicle = !nav.walking && nav.travelMode !== 'walk';
  const speed = nav.speedKmh > 2 ? nav.speedKmh : 0;
  return <SpeedSign limit={vehicle ? limit : null} speed={speed} style={{ position: 'absolute', left: 14, top }} />;
}

export function NavBottom({ nav, plan, onStop, onHere, onTurnNow, details, trafficColors, weather, extra }: {
  nav: NavState | null; plan: PlannedRoute | null;
  onStop: () => void; onHere: () => void; onTurnNow: () => void; details: ReactNode;
  trafficColors?: string[];
  weather?: WeatherAt[] | null;
  extra?: ReactNode; // например, предложения объезда
}) {
  const { wide } = useWide();
  const [open, setOpen] = useState(false);
  const gps = nav ? GPS_LABEL[nav.gps] : GPS_LABEL.none;
  const trouble = !!(nav && nav.ready && (nav.gps === 'jammed' || nav.gps === 'spoofed'));
  // Плашка не должна мигать и закрывать маршрут: показываем, только если проблема держится 10 с,
  // и даём спрятать на 10 минут. Подробности — в раскрывающейся панели.
  const [troubleShown, setTroubleShown] = useState(false);
  const [hiddenUntil, setHiddenUntil] = useState(0);
  useEffect(() => {
    if (!trouble) { setTroubleShown(false); return; }
    const id = setTimeout(() => setTroubleShown(true), 10_000);
    return () => clearTimeout(id);
  }, [trouble]);
  const showStrip = trouble && troubleShown && Date.now() > hiddenUntil;
  // Оставшееся время: плановое, пропорционально оставшемуся пути
  const left = nav?.routeLeft ?? null;
  // (маршрут из файла не знает времени — считаем по типичной скорости)
  const typical = plan?.mode === 'walk' ? 1.4 : plan?.mode === 'scooter' ? 4.2 : 16.7;
  const remain = plan && left != null
    ? plan.timeS > 0 && plan.lengthM > 0 ? (plan.timeS * left) / plan.lengthM : left / typical
    : null;
  const total = plan?.lengthM || (left != null && nav?.routeS != null ? left + nav.routeS : 0);
  const progress = total > 0 && left != null ? Math.max(0, Math.min(1, 1 - left / total)) : 0;

  return (
    <View style={[s.bottomWrap, wide && { right: undefined, width: PANEL_W }]}>
      {extra}
      {!!weather?.some((w) => w.danger.length) && <View style={{ marginBottom: 8 }}><WeatherRoute items={weather} compact /></View>}

      {showStrip && (
        <View style={s.alertStrip}>
          <Icon name={nav!.gps === 'spoofed' ? 'alert-circle' : 'satellite-variant'} size={sz(18)} color={C.red} />
          <Text style={s.alertStripText} numberOfLines={1}>
            {nav!.gps === 'spoofed' ? 'GPS подменён' : 'GPS заглушён'} · по датчикам ±{fmtDistance(nav!.sigma)}
          </Text>
          <Pressable onPress={onHere} hitSlop={8} style={s.alertStripBtn}><Text style={s.alertStripBtnText}>Я здесь</Text></Pressable>
          <Pressable onPress={() => setHiddenUntil(Date.now() + 10 * 60_000)} hitSlop={12}><Icon name="close" size={sz(18)} color={C.redText} /></Pressable>
        </View>
      )}

      <View style={s.bar}>
        <Pressable style={s.stop} onPress={onStop} hitSlop={8}><Icon name="close" size={sz(24)} color={C.red} /></Pressable>
        <Pressable style={{ flex: 1 }} onPress={() => setOpen(!open)}>
          {remain != null ? (
            <View style={s.stats}>
              <Stat value={fmtDistance(left!)} label="осталось" />
              <Stat value={fmtDuration(remain)} label="в пути" strong />
              <Stat value={fmtClock(Date.now() + remain * 1000)} label="прибытие" />
            </View>
          ) : (
            <Text style={s.statV}>{nav?.ready ? 'Едем' : 'Определяем место…'}</Text>
          )}
          {/* Полоска пройденного пути (с пробками — по их цветам) */}
          <View style={s.track}>
            {trafficColors?.length
              ? <View style={[StyleSheet.absoluteFill, { flexDirection: 'row' }]}>{trafficColors.map((c, i) => <View key={i} style={{ flex: 1, backgroundColor: c }} />)}</View>
              : null}
            <View style={[s.fill, { width: `${progress * 100}%` }]} />
            <View style={[s.knob, { left: `${progress * 100}%` }]} />
          </View>
        </Pressable>
      </View>

      {open && (
        <View style={s.more}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            <Chip text={gps.text} color={gps.color} />
            <Chip text={nav?.context ?? 'Датчики…'} color={C.blue} />
          </View>
          {trouble && !nav!.walking && <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Button small kind="secondary" text="🎯 Я здесь" onPress={onHere} />
            <Button small kind="secondary" text="↩️ Поворот сейчас" onPress={onTurnNow} />
          </View>}
          <View style={{ marginTop: 6 }}>{details}</View>
        </View>
      )}
    </View>
  );
}

function Stat({ value, label, strong }: { value: string; label: string; strong?: boolean }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={[s.statV, strong && { color: C.blue }]} numberOfLines={1}>{value}</Text>
      <Text style={s.statL}>{label}</Text>
    </View>
  );
}

const s = themed(() => ({
  man: { 
    position: 'absolute', 
    top: sz(40), 
    left: sz(12), 
    right: sz(12), 
    backgroundColor: C.dark, 
    borderRadius: sz(24), 
    padding: sz(16), 
    flexDirection: 'row', 
    alignItems: 'center', 
    ...shadow,
    elevation: 12,
  },
  arrowBox: { 
    width: sz(72), 
    height: sz(72), 
    borderRadius: sz(20), 
    backgroundColor: C.blue, 
    alignItems: 'center', 
    justifyContent: 'center', 
    marginRight: sz(16),
    shadowColor: C.blue,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: sz(4) },
    elevation: 8,
  },
  arrow: { fontSize: sz(40), color: '#fff', fontWeight: '700' },
  manDist: { fontSize: sz(32), fontWeight: '800', color: '#fff' },
  manUnit: { fontSize: sz(18), fontWeight: '600', color: C.darkHint },
  manText: { fontSize: sz(16), fontWeight: '600', color: C.darkSub, marginTop: 2 },
  bottomWrap: { position: 'absolute', left: sz(10), right: sz(10), bottom: sz(14) },
  alert: { 
    backgroundColor: C.redSoft, 
    borderRadius: sz(20), 
    padding: sz(16), 
    marginBottom: sz(8), 
    borderWidth: 2,
    borderColor: C.red,
    ...shadow 
  },
  alertStrip: {
    flexDirection: 'row', alignItems: 'center', gap: sz(8),
    backgroundColor: C.redSoft, borderRadius: sz(14), borderWidth: 1, borderColor: C.red,
    paddingHorizontal: sz(10), paddingVertical: sz(6), marginBottom: sz(6),
  },
  alertStripText: { flex: 1, fontSize: sz(13), fontWeight: '700', color: C.red },
  alertStripBtn: { backgroundColor: C.red, borderRadius: sz(10), paddingHorizontal: sz(10), paddingVertical: sz(4) },
  alertStripBtnText: { color: '#fff', fontSize: sz(12), fontWeight: '700' },
  alertHeader: { 
    flexDirection: 'row', 
    alignItems: 'flex-start',
    marginBottom: sz(12)
  },
  alertIconBox: {
    width: sz(44),
    height: sz(44),
    borderRadius: sz(22),
    backgroundColor: C.red,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: sz(12),
  },
  alertTitle: { 
    fontSize: sz(17), 
    fontWeight: '800', 
    color: C.red,
    marginBottom: sz(4),
  },
  alertSub: { 
    fontSize: sz(13), 
    color: C.redText, 
    lineHeight: sz(18),
  },
  alertStats: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderRadius: sz(12),
    padding: sz(12),
    gap: sz(12),
    marginBottom: sz(4),
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
  },
  statLabel: {
    fontSize: sz(11),
    color: C.redText,
    opacity: 0.7,
    marginBottom: 2,
  },
  statValue: {
    fontSize: sz(14),
    fontWeight: '700',
    color: C.red,
  },
  alertTip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: C.warnSoft,
    borderRadius: sz(8),
    padding: sz(8),
    marginTop: sz(8),
  },
  alertTipText: {
    flex: 1,
    fontSize: sz(11),
    color: C.warnText,
    lineHeight: sz(15),
  },
  bar: { backgroundColor: C.card, borderRadius: sz(22), paddingVertical: sz(12), paddingHorizontal: sz(12), flexDirection: 'row', alignItems: 'center', ...shadow },
  stop: { width: sz(44), height: sz(44), borderRadius: sz(22), backgroundColor: C.redSoft, alignItems: 'center', justifyContent: 'center', marginRight: sz(10) },
  stopText: { fontSize: sz(18), color: C.red, fontWeight: '800' },
  stats: { flexDirection: 'row' },
  statV: { fontSize: sz(18), fontWeight: '800', color: C.text, textAlign: 'center' },
  statL: { fontSize: sz(11), color: C.sub, marginTop: 1 },
  track: { height: sz(6), borderRadius: sz(3), backgroundColor: C.line, marginTop: sz(10), overflow: 'visible' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(120,130,145,0.85)', borderRadius: sz(3) },
  knob: { position: 'absolute', top: sz(-4), width: sz(14), height: sz(14), marginLeft: sz(-7), borderRadius: sz(7), backgroundColor: C.blue, borderWidth: 2, borderColor: C.card },
  more: { backgroundColor: C.card, borderRadius: sz(18), padding: sz(12), marginTop: sz(8), ...shadow },
}));
