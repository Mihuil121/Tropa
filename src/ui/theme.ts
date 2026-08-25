// Цвета и стили интерфейса: светлая и тёмная темы, подстройка под планшеты.
//
// Как работает смена темы: объект C один на всё приложение — при смене темы его значения
// подменяются (applyTheme), а стили, созданные через themed(), пересчитываются при следующем
// обращении. App перерисовывается — и всё приложение уже в новых цветах, без перезапуска.

import { Platform, StatusBar, StyleSheet, useWindowDimensions } from 'react-native';
import type { NavState } from '../core/engine';

const LIGHT = {
  bg: '#f2f3f5',
  card: '#ffffff',
  cardAlt: '#f7f8fa',
  text: '#1d2129',
  sub: '#6b7280',
  hint: '#9aa0a8',
  line: '#e6e8eb',
  chip: '#f1f3f6',
  accent: '#2563eb',      // главная кнопка — синяя
  accentText: '#ffffff',
  blue: '#2563eb',
  blueSoft: '#e8efff',
  blueOnSoft: '#dbe6ff',
  dark: '#111418',        // карточка манёвра
  darkSub: '#d6dbe3',
  darkHint: '#aab3c0',
  green: '#1f8a4c',
  red: '#d64545',
  redSoft: '#fdecec',
  redText: '#8a3b12',
  violet: '#8e24aa',
  amber: '#c98a00',
  warnSoft: '#fff8db',
  warnText: '#633806',
  signBg: '#ffffff',
  signText: '#111111',
  toast: '#1d2733',
  shadow: '#000000',
  passed: '#aeb6c2',      // пройденная часть маршрута
  altRoute: '#9aa6b8',
  casing: '#ffffff',
};

const DARK: typeof LIGHT = {
  bg: '#10132a',
  card: '#1b2140',
  cardAlt: '#222a4d',
  text: '#eef1f5',
  sub: '#a3acb9',
  hint: '#6f7885',
  line: '#2c3458',
  chip: '#262e52',
  accent: '#3b82f6',
  accentText: '#ffffff',
  blue: '#6d8bff',
  blueSoft: '#232c5c',
  blueOnSoft: '#c9d9ff',
  dark: '#0c0f22',
  darkSub: '#cfd5df',
  darkHint: '#8d96a3',
  green: '#3fbf6f',
  red: '#ff6b6b',
  redSoft: '#3a1f22',
  redText: '#ffb4a8',
  violet: '#c77dff',
  amber: '#e0a526',
  warnSoft: '#3a3220',
  warnText: '#ffe2a3',
  signBg: '#ffffff',
  signText: '#111111',
  toast: '#2a3260',
  shadow: '#000000',
  passed: '#59616e',
  altRoute: '#5d6878',
  casing: '#10132a',
};

export type ThemeMode = 'auto' | 'light' | 'dark';
export const C = { ...LIGHT };
export let isDark = false;
let version = 0;

// ---------- Маленькие экраны ----------
// Все размеры в стилях (шрифты, отступы, высоты) умножаются на K. Базовый экран — 392×780 dp
// (обычный современный телефон). На узких (320–360 dp) и низких (до ~700 dp) — пропорционально
// меньше, но не меньше 0.8, чтобы текст оставался читаемым. На больших — без увеличения.

/** Масштаб размеров интерфейса. */
export let K = 1;
/** Низкий экран: прячем второстепенные подсказки, панели компактнее. */
export let compact = false;
/** Размер с учётом масштаба экрана. */
export const sz = (n: number) => Math.round(n * (n <= 12 ? Math.max(K, 0.92) : K)); // мелкое (подписи 10–12) почти не уменьшаем

/** Подстроить размеры под экран. Возвращает true, если что-то поменялось. */
export function applyScreen(width: number, height: number): boolean {
  const short = Math.min(width, height), long = Math.max(width, height);
  const raw = Math.min(short / 392, long / 780, 1);
  const k = Math.max(0.8, Math.round(raw * 20) / 20); // шаг 0.05, чтобы не пересчитывать на каждый пиксель
  const c = long < 700;
  if (k === K && c === compact) return false;
  K = k; compact = c;
  version++;
  return true;
}

/** Включить тему. Возвращает true, если что-то поменялось. */
export function applyTheme(dark: boolean): boolean {
  if (dark === isDark && version > 0) return false;
  isDark = dark;
  Object.assign(C, dark ? DARK : LIGHT);
  version++;
  return true;
}
applyTheme(false);

/**
 * Стили, которые пересчитываются при смене темы. Пишется так же, как StyleSheet.create:
 *   const s = themed(() => ({ title: { color: C.text } }));
 */
type Styles = Parameters<typeof StyleSheet.create>[0];
export function themed<T extends Styles>(make: () => T & Styles): Readonly<T> {
  let cache: T | null = null, v = -1;
  return new Proxy({} as T, {
    get(_t, key) {
      if (v !== version) { cache = make(); v = version; }
      return (cache as any)[key];
    },
  });
}

export const shadow = {
  elevation: 6,
  shadowColor: '#000',
  shadowOpacity: 0.12,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
};

export const GPS_LABEL: Record<NavState['gps'], { text: string; color: string; icon: string }> = new Proxy({} as any, {
  get(_t, k: string) {
    const m: Record<string, { text: string; color: string; icon: string }> = {
      none: { text: 'Ищем спутники', color: C.hint, icon: 'satellite-variant' },
      ok: { text: 'GPS в норме', color: C.green, icon: 'check-circle' },
      checking: { text: 'Проверяем GPS', color: C.amber, icon: 'timer-sand' },
      jammed: { text: 'GPS заглушён', color: C.red, icon: 'satellite-variant' },
      spoofed: { text: 'GPS подменён', color: C.violet, icon: 'alert-circle' },
    };
    return m[k];
  },
});

/** Ширина «панели» на планшете (или в альбомной ориентации): карта справа, панели слева. */
export const PANEL_W = 420;

/** Широкий экран (планшет/альбомная ориентация) — панели не во всю ширину, а слева. */
export function useWide() {
  const { width, height } = useWindowDimensions();
  return { wide: width >= 720, width, height, landscape: width > height };
}

/** Отступы под шторку и системную панель — чтобы карточки не залезали под статус-бар. */
export function useInsets() {
  const { width, height } = useWindowDimensions();
  const top = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) + sz(8) : 54;
  return { top, bottom: sz(18), width, height, wide: width >= 720 };
}

export const ui = themed(() => ({
  card: { backgroundColor: C.card, borderRadius: sz(18), ...shadow },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.card, borderTopLeftRadius: sz(26), borderTopRightRadius: sz(26), paddingHorizontal: sz(16), paddingTop: sz(8), paddingBottom: sz(22), ...shadow },
  /** На планшете нижняя панель становится плавающей карточкой слева. */
  sheetWide: { left: sz(16), right: undefined, width: PANEL_W, bottom: sz(16), borderRadius: sz(26) },
  grabber: { alignSelf: 'center', width: sz(40), height: sz(4), borderRadius: 2, backgroundColor: C.line, marginBottom: sz(10) },
  h1: { fontSize: sz(22), fontWeight: '700', color: C.text },
  h2: { fontSize: sz(17), fontWeight: '700', color: C.text },
  body: { fontSize: sz(15), color: C.text },
  sub: { fontSize: sz(13), color: C.sub },
  row: { flexDirection: 'row', alignItems: 'center' },
}));
