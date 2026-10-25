import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOptions, buildArgs, shouldRestart } from '../modules/opera-proxy/logic.ts';
import { createOperaProxyManager } from '../modules/opera-proxy/operaProxyManager.ts';

test('opera-proxy: validateOptions и buildArgs', () => {
  const v = validateOptions({ country: 'AS', serverSelection: 'fastest', initRetries: 5, timeout: '5s' });
  assert.equal(v.country, 'AS');
  assert.equal(v.serverSelection, 'fastest');
  assert.equal(v.initRetries, 5);
  assert.equal(v.timeout, '5s');

  const v2 = validateOptions({ country: 'XX', serverSelection: 'unknown', initRetries: -1, timeout: 'bad' });
  assert.equal(v2.country, 'EU');
  assert.equal(v2.serverSelection, 'first');
  assert.equal(v2.initRetries, 3);
  assert.equal(v2.timeout, '10s');

  const args = buildArgs({ country: 'EU' }, 18080, '/lib/libopera_proxy.so');
  assert.ok(args.includes('-bind-address'));
  assert.ok(args.includes('127.0.0.1:18080'));
  assert.ok(args.includes('EU'));
});

test('opera-proxy: shouldRestart (30 сек, макс 3)', () => {
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
  let logListeners: any[] = [];

  const fakeNative = {
    isSupported: () => true,
    start: async (opts: any) => {
      startCalls++;
      state = 'starting';
      port = 18080;
      return { port };
    },
    stop: () => {
      stopCalls++;
      state = 'stopped';
      port = 0;
    },
    status: () => ({ state, port, country: 'EU' }),
    addListener: (name: string, cb: any) => {
      if (name === 'onLog') logListeners.push(cb);
      return { remove: () => {} };
    },
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
  assert.equal(statuses[statuses.length - 1].state, 'ready');

  state = 'failed';
  currentTime += 5000;
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
