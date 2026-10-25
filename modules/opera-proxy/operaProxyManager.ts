import type { OperaProxyOptions, OperaProxyStatus } from './index.ts';
import { shouldRestart, maskSensitive } from './logic.ts';

type NativeModule = {
  isSupported(): boolean;
  start(options?: OperaProxyOptions): Promise<{ port: number }>;
  stop(): void;
  status(): OperaProxyStatus;
  addListener(eventName: string, listener: (event: { line: string }) => void): { remove: () => void };
};

export type ManagerDeps = {
  now?: () => number;
  setInterval?: (cb: () => void, ms: number) => any;
  clearInterval?: (timer: any) => void;
  dlog?: (msg: string) => void;
  dlogError?: (label: string, e: unknown) => void;
};

export function createOperaProxyManager(native: NativeModule | null, deps: ManagerDeps = {}) {
  const now = deps.now || Date.now;
  const setIntervalFn = deps.setInterval || (typeof setInterval !== 'undefined' ? setInterval : () => {});
  const clearIntervalFn = deps.clearInterval || (typeof clearInterval !== 'undefined' ? clearInterval : () => {});
  const dlog = deps.dlog || (() => {});
  const dlogError = deps.dlogError || (() => {});

  type Listener = (status: OperaProxyStatus) => void;
  const listeners = new Set<Listener>();

  let lastOptions: OperaProxyOptions | undefined = undefined;
  let failureTimestamps: number[] = [];
  let logSub: { remove: () => void } | null = null;
  let timer: any = null;

  function notify(st: OperaProxyStatus) {
    listeners.forEach((l) => { try { l(st); } catch {} });
  }

  function setupLogSub() {
    if (logSub || !native) return;
    try {
      logSub = native.addListener('onLog', (event) => {
        const line = maskSensitive(event.line);
        dlog(`opera-proxy: ${line}`);
      });
    } catch {}
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    try {
      if (native?.isSupported()) {
        const st = native.status();
        if (st) listener(st);
      }
    } catch {}
    setupLogSub();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && logSub) {
        try { logSub.remove(); } catch {}
        logSub = null;
      }
    };
  }

  function start(opts?: OperaProxyOptions) {
    lastOptions = opts;
    if (!native?.isSupported()) return;
    setupLogSub();
    native.start(opts)
      .then((res) => {
        dlog(`opera-proxy: запущен на порту ${res.port}`);
        const st = native.status();
        if (st) {
          if (st.state === 'ready') {
            failureTimestamps = [];
          }
          notify(st);
        }
      })
      .catch((e) => {
        dlogError('opera-proxy: ошибка старта', e);
        const st = native.status();
        if (st) notify(st);
      });
  }

  function stop() {
    lastOptions = undefined;
    failureTimestamps = [];
    if (!native?.isSupported()) return;
    native.stop();
    const st = native.status();
    if (st) notify(st);
  }

  // Поллинг статуса и авто-перезапуск (только при state === 'failed')
  if (timer) clearIntervalFn(timer);
  timer = setIntervalFn(() => {
    if (!native?.isSupported()) return;
    try {
      const st = native.status();
      if (!st) return;
      notify(st);
      if (st.state === 'ready') {
        if (failureTimestamps.length > 0) {
          failureTimestamps = [];
        }
      } else if (st.state === 'failed') {
        const tNow = now();
        if (lastOptions && shouldRestart(failureTimestamps, tNow)) {
          failureTimestamps.push(tNow);
          if (failureTimestamps.length > 3) {
            failureTimestamps = failureTimestamps.slice(-3);
          }
          dlog('opera-proxy: попытка авто-перезапуска после сбоя...');
          start(lastOptions);
        }
      }
    } catch {}
  }, 2000);

  return {
    subscribe,
    start,
    stop,
    status: () => native?.isSupported() ? native.status() : { state: 'stopped' as const },
  };
}
