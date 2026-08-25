// Временный журнал отладки: последние ~300 строк, видны на экране (кнопка 🐞)
// и отправляются кнопкой «Поделиться». Потом уберём.

type Listener = () => void;

const lines: string[] = [];
const listeners = new Set<Listener>();
const counters: Record<string, number> = {};

function stamp() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function dlog(...parts: unknown[]) {
  const text = parts.map((p) => (typeof p === 'string' ? p : safeJson(p))).join(' ');
  lines.push(`${stamp()} ${text}`);
  if (lines.length > 300) lines.splice(0, lines.length - 300);
  listeners.forEach((l) => l());
}

/** То же, но не чаще одного раза в `everyN` вызовов (для частых событий вроде GPS). */
export function dlogEvery(key: string, everyN: number, ...parts: unknown[]) {
  const n = (counters[key] = (counters[key] ?? 0) + 1);
  if (n === 1 || n % everyN === 0) dlog(`[${key} #${n}]`, ...parts);
}

export function count(key: string) { return counters[key] ?? 0; }

export function dlogError(where: string, e: unknown) {
  const err = e as any;
  dlog(`❌ ${where}: ${err?.message ?? String(e)}`, err?.stack ? String(err.stack).split('\n').slice(0, 3).join(' | ') : '');
}

export function getLines() { return lines; }
export function subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; }

function safeJson(x: unknown) {
  try { return JSON.stringify(x); } catch { return String(x); }
}

// Ловим все необработанные ошибки JS — они тоже попадут в журнал
const EU = (globalThis as any).ErrorUtils;
if (EU?.setGlobalHandler) {
  const prev = EU.getGlobalHandler?.();
  EU.setGlobalHandler((e: unknown, fatal?: boolean) => {
    dlogError(fatal ? 'FATAL' : 'JS', e);
    prev?.(e, fatal);
  });
}
