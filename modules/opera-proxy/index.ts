import { requireOptionalNativeModule } from 'expo';

export type OperaProxyOptions = {
  country?: 'EU' | 'AS' | 'AM' | string;
  serverSelection?: 'first' | 'random' | 'fastest';
  initRetries?: number;
  timeout?: string;
  apiProxyFile?: string;
};

export type OperaProxyStatus = {
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  port?: number;
  country?: string;
  lastError?: string;
};

type OperaProxyNative = {
  /** Поддерживается ли запуск нативного бинарника на устройстве. */
  isSupported(): boolean;
  /** Запустить локальный прокси. */
  start(options?: OperaProxyOptions): Promise<{ port: number }>;
  /** Остановить прокси-процесс. */
  stop(): void;
  /** Текущее состояние прокси. */
  status(): OperaProxyStatus;
};

const OperaProxy = requireOptionalNativeModule<OperaProxyNative>('OperaProxy');
export default OperaProxy;
