// Слабый телефон? Тогда — «лёгкий режим»: меньше перерисовок и тяжёлых слоёв карты.
//
// Определяем по версии Android: до Android 9 (API 28) включительно — почти всегда старое
// железо с 2–3 ГБ памяти. Пользователь может включить/выключить режим в настройках сам.

import { Platform } from 'react-native';

export type LiteSetting = 'auto' | 'on' | 'off';

export const oldDevice: boolean = Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version <= 28;

export function isLite(setting: LiteSetting | undefined): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return oldDevice;
}
