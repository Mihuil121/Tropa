import { requireOptionalNativeModule } from 'expo';
import { createOperaProxyManager } from './operaProxyManager.ts';
import { dlog, dlogError } from '../../src/debugLog.ts';

export * from './logic.ts';
export * from './operaProxyManager.ts';

export type OperaProxyOptions = {
  country?: 'EU' | 'AS' | 'AM' | string;
  serverSelection?: 'first' | 'random' | 'fastest';
  initRetries?: number;
  timeout?: string;
  apiProxyFile?: string;
  probeHost?: string;
};

export type OperaProxyStatus = {
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  port?: number;
  country?: string;
  lastError?: string;
};

type OperaProxyNative = {
  isSupported(): boolean;
  start(options?: OperaProxyOptions): Promise<{ port: number }>;
  stop(): void;
  status(): OperaProxyStatus;
  addListener(eventName: string, listener: (event: { line: string }) => void): { remove: () => void };
};

const OperaProxy = requireOptionalNativeModule<OperaProxyNative>('OperaProxy');
export default OperaProxy;

export const operaProxyManager = createOperaProxyManager(OperaProxy, { dlog, dlogError });
export const subscribeOperaProxy = operaProxyManager.subscribe;
export const startOperaProxy = operaProxyManager.start;
export const stopOperaProxy = operaProxyManager.stop;
