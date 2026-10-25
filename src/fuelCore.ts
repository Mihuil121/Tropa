// Чистая логика поиска заправок с внедрением зависимостей (тестируема в Node без expo-file-system).

import type { FuelStation, FuelResult, LatLonP } from './fuelStatus.ts';

export type FuelCoreDeps = {
  fetchAround: (c: LatLonP, km: number, signal?: AbortSignal) => Promise<FuelStation[]>;
  loadCache: (c: LatLonP) => Promise<FuelResult | null>;
  saveCache: (c: LatLonP, list: FuelStation[]) => Promise<void>;
  log?: { info(msg: string): void; error(label: string, e: unknown): void };
};

export async function findFuelWith(deps: FuelCoreDeps, c: LatLonP, signal?: AbortSignal): Promise<FuelResult> {
  try {
    for (const km of [5, 10, 20]) {
      const list = await deps.fetchAround(c, km, signal);
      if (list.length) {
        void deps.saveCache(c, list);
        deps.log?.info(`заправки: ${list.length} в радиусе ${km} км`);
        return { stations: list, fromCache: false, reason: 'ok', stale: false };
      }
    }
    const cached = await deps.loadCache(c);
    if (cached && cached.stations.length) {
      deps.log?.info('заправки: показан кэш');
      return cached;
    }
    return { stations: [], fromCache: false, reason: 'empty', stale: false, error: 'Заправок поблизости не найдено' };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    deps.log?.error('заправки: Overpass', e);
    const cached = await deps.loadCache(c);
    if (cached && cached.stations.length) {
      deps.log?.info('заправки: показан кэш');
      return { ...cached, error: 'Нет связи с интернетом. Показан сохраненный кэш.', reason: 'network', stale: cached.stale ?? false };
    }
    return { stations: [], fromCache: false, reason: 'network', stale: false, error: 'Нет связи с картой заправок. Проверьте интернет или VPN.' };
  }
}
