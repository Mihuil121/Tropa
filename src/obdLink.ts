// Связка: Bluetooth-модуль (Kotlin) <-> протокол ELM327 (ядро) <-> навигатор.

import { PermissionsAndroid, Platform } from 'react-native';
import CarSensors from '../modules/car-sensors';
import { ElmPoller } from './core/obd';

export type ObdState = 'off' | 'connecting' | 'on' | 'error';

export async function ensureBtPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (Platform.Version >= 31) {
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
    return r === PermissionsAndroid.RESULTS.GRANTED;
  }
  return true;
}

export async function listAdapters() {
  if (!CarSensors) return [];
  if (!(await ensureBtPermission())) return [];
  return CarSensors.listBondedDevices();
}

export class ObdLink {
  state: ObdState = 'off';
  error = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private subs: { remove(): void }[] = [];
  private busy = false;

  constructor(
    private onSpeed: (t: number, kmh: number) => void,
    private onState: (s: ObdState, err: string) => void,
  ) {}

  private set(s: ObdState, err = '') { this.state = s; this.error = err; this.onState(s, err); }

  async connect(address: string) {
    if (!CarSensors) { this.set('error', 'Модуль Bluetooth недоступен в этой сборке'); return; }
    this.disconnect();
    this.set('connecting');
    try {
      await CarSensors.connectObd(address);
      const poller = new ElmPoller((s) => CarSensors!.writeObd(s).then(() => undefined));
      this.subs.push(CarSensors.addListener('onObdData', (e) => poller.onData(e.data)));
      this.subs.push(CarSensors.addListener('onObdClosed', () => this.set('error', 'Адаптер отключился')));
      if (!(await poller.init())) { this.set('error', 'Адаптер ответил, но машина не отдаёт скорость (заведите двигатель)'); return; }
      this.set('on');
      // 3 запроса в секунду: дешёвые клоны быстрее не успевают
      this.timer = setInterval(async () => {
        if (this.busy) return;
        this.busy = true;
        const kmh = await poller.readSpeedKmh();
        this.busy = false;
        if (kmh !== null) this.onSpeed(Date.now() / 1000, kmh);
      }, 330);
    } catch (e: any) {
      this.set('error', e?.message ?? String(e));
    }
  }

  disconnect() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    CarSensors?.disconnectObd().catch(() => {});
    if (this.state !== 'off') this.set('off');
  }
}
