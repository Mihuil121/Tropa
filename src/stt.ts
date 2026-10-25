// Голосовой ввод: expo-speech-recognition, русский язык, промежуточный текст по мере речи.
// Если в телефоне есть распознавание без сети, пробуем его; нет русского пакета — следующая попытка идёт онлайн.

import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { voice } from './voice';
import { dlog, dlogError } from './debugLog';

export type SttHandlers = {
  onText: (text: string, final: boolean) => void;
  onEnd: () => void;
  onError: (message: string) => void;
};

let subs: { remove: () => void }[] = [];
let active = false;
let preferOnDevice = true;

function cleanup() {
  subs.forEach((s) => { try { s.remove(); } catch {} });
  subs = [];
  active = false;
}

/** Начать слушать. Любая неудача сообщается через onError и onEnd (приложение не падает). */
export async function startListening(h: SttHandlers): Promise<void> {
  if (active) return;
  voice.stop(); // чтобы озвучка маршрута не попала в микрофон
  try {
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) { h.onError('Нет разрешения на микрофон'); h.onEnd(); return; }
  } catch (e) {
    dlogError('голос: разрешение', e);
    h.onError('Голосовой ввод недоступен'); h.onEnd(); return;
  }
  let onDevice = false;
  try { onDevice = preferOnDevice && ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(); } catch {}
  active = true;
  subs.push(ExpoSpeechRecognitionModule.addListener('result', (e) => {
    const t = e.results?.[0]?.transcript ?? '';
    if (t) h.onText(t, !!e.isFinal);
  }));
  subs.push(ExpoSpeechRecognitionModule.addListener('error', (e) => {
    dlog(`голос: ошибка ${e.error}: ${e.message}`);
    if (e.error === 'language-not-supported' || e.error === 'service-not-allowed') {
      if (onDevice) {
        preferOnDevice = false; // следующая попытка — через обычное распознавание
        h.onError('Русский пакет без сети не скачан. Нажмите микрофон ещё раз (нужен интернет) или скачайте пакет в настройках телефона');
      } else {
        h.onError('Голосовой ввод недоступен на этом телефоне');
      }
    } else if (e.error === 'network') {
      h.onError('Нет сети, введите текстом');
    } else if (e.error === 'no-speech') {
      h.onError('Не расслышали, попробуйте ещё раз');
    } else if (e.error === 'not-allowed') {
      h.onError('Нет разрешения на микрофон');
    } else if (e.error !== 'aborted') {
      h.onError('Голосовой ввод недоступен');
    }
    cleanup();
    h.onEnd();
  }));
  subs.push(ExpoSpeechRecognitionModule.addListener('end', () => { cleanup(); h.onEnd(); }));
  try {
    ExpoSpeechRecognitionModule.start({ lang: 'ru-RU', interimResults: true, continuous: false, requiresOnDeviceRecognition: onDevice });
  } catch (e) {
    dlogError('голос: start', e);
    cleanup();
    h.onError('Голосовой ввод недоступен'); h.onEnd();
  }
}

/** Закончить речь и получить итоговый текст. */
export function stopListening() { try { ExpoSpeechRecognitionModule.stop(); } catch {} }

/** Прервать без результата (например, при закрытии экрана). */
export function abortListening() {
  if (!active) return;
  try { ExpoSpeechRecognitionModule.abort(); } catch {}
  cleanup();
}
