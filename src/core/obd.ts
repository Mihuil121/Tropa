// Протокол адаптера ELM327 (OBD-II). Транспорт (Bluetooth) — отдельно, тут только текст.
// Нужен ровно один параметр: скорость машины (PID 0x0D), её считают датчики колёс.

export const ELM_INIT = ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0'];
export const SPEED_CMD = '010D';

/**
 * Разбирает ответ на 010D. Примеры ответов клонов:
 *   "410D3C\r\r>"     "41 0D 3C"     "SEARCHING...\r410D3C"     "NO DATA"
 * Возвращает км/ч или null.
 */
export function parseSpeedResponse(raw: string): number | null {
  const clean = raw.toUpperCase().replace(/SEARCHING\.\.\./g, '').replace(/[\s>]/g, '');
  const i = clean.indexOf('410D');
  if (i < 0) return null;
  const hex = clean.slice(i + 4, i + 6);
  if (!/^[0-9A-F]{2}$/.test(hex)) return null;
  return parseInt(hex, 16);
}

/** Простой «опросчик»: шлёт команду, ждёт '>' (приглашение ELM327), отдаёт скорость. */
export class ElmPoller {
  private buf = '';
  private waiter: ((s: string) => void) | null = null;

  private write: (s: string) => Promise<void>;
  constructor(write: (s: string) => Promise<void>) { this.write = write; }

  /** Транспорт вызывает это на каждый пришедший кусок данных. */
  onData(chunk: string) {
    this.buf += chunk;
    const k = this.buf.indexOf('>');
    if (k >= 0 && this.waiter) {
      const resp = this.buf.slice(0, k);
      this.buf = this.buf.slice(k + 1);
      const w = this.waiter;
      this.waiter = null;
      w(resp);
    }
  }

  private send(cmd: string, timeoutMs = 3000): Promise<string> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.waiter = null; resolve(''); }, timeoutMs);
      this.waiter = (s) => { clearTimeout(t); resolve(s); };
      this.write(cmd + '\r').catch(() => resolve(''));
    });
  }

  async init(): Promise<boolean> {
    for (const c of ELM_INIT) await this.send(c, c === 'ATZ' ? 5000 : 2000);
    // Первый запрос может занять пару секунд, пока адаптер подбирает протокол
    const r = await this.send(SPEED_CMD, 10000);
    return parseSpeedResponse(r) !== null;
  }

  async readSpeedKmh(): Promise<number | null> {
    return parseSpeedResponse(await this.send(SPEED_CMD, 1500));
  }
}
