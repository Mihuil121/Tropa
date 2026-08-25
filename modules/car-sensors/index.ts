import { requireOptionalNativeModule } from 'expo';

export type NativeCell = {
  radio: 'LTE' | 'GSM' | 'UMTS' | 'NR';
  mcc: number; mnc: number; area: number; cid: number;
  dbm: number; registered: boolean;
  ta?: number; // timing advance (только LTE, «своя» вышка)
};

export type NativeGnssSignal = { used: number; total: number; cn0Top: number; cn0Std: number; agc?: number };

type Sub = { remove(): void };

type CarSensorsNative = {
  getCells(): Promise<NativeCell[]>;
  listBondedDevices(): Promise<{ name: string; address: string }[]>;
  connectObd(address: string): Promise<boolean>;
  writeObd(data: string): Promise<boolean>;
  disconnectObd(): Promise<boolean>;
  startGnssMonitor(): Promise<boolean>;
  stopGnssMonitor(): Promise<boolean>;
  startNetworkLocation(): Promise<boolean>;
  stopNetworkLocation(): Promise<boolean>;
  getWifi(): Promise<{ bssid: string; dbm: number }[]>;
  addListener(event: 'onObdData', cb: (e: { data: string }) => void): Sub;
  addListener(event: 'onObdClosed', cb: () => void): Sub;
  addListener(event: 'onGnssSignal', cb: (e: NativeGnssSignal) => void): Sub;
  addListener(event: 'onNetworkLocation', cb: (e: { lat: number; lon: number; accuracy: number; age: number }) => void): Sub;
};

// Optional: в Expo Go / на iOS модуля нет — приложение тогда просто работает без вышек и OBD.
const CarSensors = requireOptionalNativeModule<CarSensorsNative>('CarSensors');
export default CarSensors;
