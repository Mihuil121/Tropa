// Чистая логика валидации опций, построения аргументов и проверки авто-перезапуска (тестируема в Node).

export type OperaProxyOptions = {
  country?: string;
  serverSelection?: string;
  initRetries?: number;
  timeout?: string;
  apiProxyFile?: string;
  probeHost?: string;
};

export function validateOptions(opts?: OperaProxyOptions): { country: string; serverSelection: string; initRetries: number; timeout: string; apiProxyFile?: string; probeHost: string } {
  const country = opts?.country && ['EU', 'AS', 'AM'].includes(opts.country) ? opts.country : 'EU';
  const serverSelection = opts?.serverSelection && ['first', 'random', 'fastest'].includes(opts.serverSelection) ? opts.serverSelection : 'first';
  const initRetries = typeof opts?.initRetries === 'number' && opts.initRetries > 0 ? opts.initRetries : 3;
  const timeout = opts?.timeout && /^\d+[smh]$/.test(opts.timeout) ? opts.timeout : '10s';
  const probeHost = opts?.probeHost || 'overpass-api.de:443';
  return {
    country,
    serverSelection,
    initRetries,
    timeout,
    apiProxyFile: opts?.apiProxyFile,
    probeHost,
  };
}

export function buildArgs(opts: OperaProxyOptions, port: number, libPath: string): string[] {
  const v = validateOptions(opts);
  const args = [
    libPath,
    '-bind-address', `127.0.0.1:${port}`,
    '-country', v.country,
    '-server-selection', v.serverSelection,
    '-init-retries', String(v.initRetries),
    '-timeout', v.timeout,
  ];
  if (v.apiProxyFile) {
    args.push('-api-proxy-file', v.apiProxyFile);
  }
  return args;
}

/**
 * shouldRestart: не чаще раза в 30 с, максимум 3 подряд.
 * restartHistory содержит таймстампы падений.
 */
export function shouldRestart(restartHistory: number[], now = Date.now()): boolean {
  if (restartHistory.length >= 3) return false;
  if (restartHistory.length > 0) {
    const last = restartHistory[restartHistory.length - 1];
    if (now - last < 30_000) return false;
  }
  return true;
}
