import OperaProxy, { type OperaProxyOptions, type OperaProxyStatus } from './index.ts';
import { shouldRestart } from './logic.ts';
import { dlog, dlogError } from '../../src/debugLog.ts';

type Listener = (status: OperaProxyStatus) => void;
const listeners = new Set<Listener>();

let lastOptions: OperaProxyOptions | undefined = undefined;
let failureTimestamps: number[] = [];

export function subscribeOperaProxy(listener: Listener): () => void {
  listeners.add(listener);
  try {
    if (OperaProxy?.isSupported()) {
      const st = OperaProxy?.status();
      if (st) listener(st);
    }
  } catch {}
  return () => { listeners.delete(listener); };
}

function notify(st: OperaProxyStatus) {
  listeners.forEach((l) => { try { l(st); } catch {} });
}

export function startOperaProxy(opts?: OperaProxyOptions) {
  lastOptions = opts;
  if (!OperaProxy?.isSupported()) return;
  OperaProxy.start(opts)
    .then((res) => {
      dlog(`opera-proxy: запущен на порту ${res.port}`);
      const st = OperaProxy?.status();
      if (st) notify(st);
    })
    .catch((e) => {
      dlogError('opera-proxy: ошибка старта', e);
      const st = OperaProxy?.status();
      if (st) notify(st);
    });
}

export function stopOperaProxy() {
  if (!OperaProxy?.isSupported()) return;
  OperaProxy.stop();
  const st = OperaProxy?.status();
  if (st) notify(st);
}

// Поллинг статуса и авто-перезапуск
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    if (!OperaProxy?.isSupported()) return;
    try {
      const st = OperaProxy?.status();
      if (!st) return;
      notify(st);
      if (st.state === 'failed' || st.state === 'stopped') {
        const now = Date.now();
        if (lastOptions && shouldRestart(failureTimestamps, now)) {
          failureTimestamps.push(now);
          if (failureTimestamps.length > 3) {
            failureTimestamps = failureTimestamps.slice(-3);
          }
          dlog('opera-proxy: попытка авто-перезапуска после сбоя...');
          startOperaProxy(lastOptions);
        }
      }
    } catch {}
  }, 2000);
}
