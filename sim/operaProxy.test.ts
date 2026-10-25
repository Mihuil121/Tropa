import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOptions, buildArgs, shouldRestart, maskSensitive } from '../modules/opera-proxy/logic.ts';
import { createOperaProxyManager } from '../modules/opera-proxy/operaProxyManager.ts';

test('opera-proxy: maskSensitive для Basic авторизации и токенов', () => {
  const line1 = 'Proxy-Authorization: Basic dXNlcjpwYXNz';
  assert.equal(maskSensitive(line1), 'Proxy-Authorization: ***');

  const line2 = 'password=secret123';
  assert.equal(maskSensitive(line2), 'password: ***');
});

test('opera-proxy: shouldRestart (максимум 3 рестарта, сброс после ready)', () => {
  const now = 100_000;
  assert.equal(shouldRestart([], now), true);
  assert.equal(shouldRestart([now - 10_000], now), false);
  assert.equal(shouldRestart([now - 35_000], now), true);
  assert.equal(shouldRestart([now - 100_000, now - 60_000, now - 35_000], now), false);
});

test('opera-proxy: менеджер состояний и авто-перезапуск (фейковый native)', async () => {
  let state: 'stopped' | 'starting' | 'ready' | 'failed' = 'stopped';
  let port = 0;
  let startCalls = 0;
  let stopCalls = 0;

  const fakeNative = {
    isSupported: () => true,
    start: async (opts: any) => {
      startCalls++;
      state = 'ready';
      port = 18080;
      return { port };
    },
    stop: () => {
      stopCalls++;
      state = 'stopped';
      port = 0;
    },
    status: () => ({ state, port: state === 'ready' ? port : undefined, country: 'EU' }),
    addListener: (name: string, cb: any) => ({ remove: () => {} }),
  };

  let timers: any[] = [];
  const fakeSetInterval = (cb: any, ms: number) => {
    const t = { cb, ms, active: true };
    timers.push(t);
    return t;
  };
  const fakeClearInterval = (t: any) => {
    if (t) t.active = false;
  };

  let currentTime = 1000;
  const manager = createOperaProxyManager(fakeNative, {
    now: () => currentTime,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    dlog: () => {},
  });

  const statuses: any[] = [];
  const unsub = manager.subscribe((st) => statuses.push(st));

  manager.start({ country: 'EU' });
  assert.equal(startCalls, 1);

  state = 'ready';
  for (const t of timers) if (t.active) t.cb();

  state = 'failed';
  currentTime += 35_000;
  for (const t of timers) if (t.active) t.cb();
  assert.equal(startCalls, 2);

  manager.stop();
  assert.equal(stopCalls, 1);
  state = 'stopped';
  currentTime += 40_000;
  for (const t of timers) if (t.active) t.cb();
  assert.equal(startCalls, 2);

  unsub();
});
