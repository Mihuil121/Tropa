// Чистая логика статусов АЗС (без зависимости от expo-file-system, тестируема в Node).

export type FuelKind = '92' | '95' | '98' | '100' | 'diesel' | 'lpg';
export type FuelStatus = 'yes' | 'low' | 'no' | 'unknown';
export type FuelReportItem = { status: 'yes' | 'low' | 'no'; t: number };
export type FuelReports = Record<string, FuelReportItem>;

export const FUEL_LABEL: Record<FuelKind, string> = { '92': 'АИ-92', '95': 'АИ-95', '98': 'АИ-98', '100': 'АИ-100', diesel: 'ДТ', lpg: 'Газ' };
const REPORT_TTL_MS = 12 * 3600_000; // отметка «есть/нет» живёт 12 часов

export function displayStatus(report?: FuelReportItem, now = Date.now()): { status: FuelStatus; text: string; color: string } {
  if (!report || now - report.t >= REPORT_TTL_MS) {
    return { status: 'unknown', text: 'Нет данных', color: '#868e96' };
  }
  if (report.status === 'yes') {
    if (now - report.t < 3 * 3600_000) {
      return { status: 'yes', text: 'Есть топливо', color: '#2f9e44' };
    }
    return { status: 'yes', text: 'Давно не проверяли', color: '#f59f00' };
  }
  if (report.status === 'low') {
    return { status: 'low', text: 'Мало / очередь', color: '#f59f00' };
  }
  if (report.status === 'no') {
    return { status: 'no', text: 'Нет топлива', color: '#e03131' };
  }
  return { status: 'unknown', text: 'Нет данных', color: '#868e96' };
}

export function statusOf(r: FuelReports, id: string): FuelStatus {
  return displayStatus(r[id]).status;
}
