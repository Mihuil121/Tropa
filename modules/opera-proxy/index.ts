import { requireOptionalNativeModule } from 'expo';
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
};

const OperaProxy = requireOptionalNativeModule<OperaProxyNative>('OperaProxy');
export default OperaProxy;
