// Голосовые подсказки на русском языке через expo-speech.

import * as Speech from 'expo-speech';
import type { GpsStatus } from './core/engine';

class VoiceAssistant {
  enabled = true;
  private lastText = '';
  private lastTime = 0;
  private lastManeuverKey = '';

  /** Озвучить произвольную фразу */
  speak(text: string, force = false) {
    if (!this.enabled || !text) return;
    const now = Date.now();
    // Избегаем частых повторов одной и той же фразы (минимум 8 секунд задержка, если не принудительно)
    if (!force && text === this.lastText && now - this.lastTime < 8000) return;

    this.lastText = text;
    this.lastTime = now;

    try {
      Speech.speak(text, {
        language: 'ru-RU',
        pitch: 1.0,
        rate: 0.95, // Слегка замедленный чёткий темп для авто
      });
    } catch {
      // Игнорируем ошибки если синтез недоступен
    }
  }

  /** Остановить речь */
  stop() {
    try {
      Speech.stop();
    } catch {}
  }

  /** Озвучить маневр по дистанции */
  announceManeuver(distM: number, text: string) {
    if (!this.enabled || !text) return;

    let bucket = '';
    if (distM <= 40) bucket = 'now';
    else if (distM <= 120) bucket = '100m';
    else if (distM <= 300) bucket = '250m';
    else if (distM <= 600) bucket = '500m';
    else if (distM <= 1200) bucket = '1km';

    if (!bucket) return;

    const key = `${text}:${bucket}`;
    if (key === this.lastManeuverKey) return;
    this.lastManeuverKey = key;

    let prefix = '';
    if (bucket === 'now') prefix = 'Сейчас ';
    else if (bucket === '100m') prefix = 'Через 100 метров ';
    else if (bucket === '250m') prefix = 'Через 250 метров ';
    else if (bucket === '500m') prefix = 'Через 500 метров ';
    else if (bucket === '1km') prefix = 'Через один километр ';

    this.speak(`${prefix}${text}`, true);
  }

  /** Озвучить смену статуса GPS */
  announceGpsStatus(status: GpsStatus, reason = '') {
    if (!this.enabled) return;

    if (status === 'jammed') {
      this.speak('Внимание! GPS заглушён. Навигация продолжается по вышкам и датчикам.', true);
    } else if (status === 'spoofed') {
      this.speak('Внимание! Обнаружена подмена GPS. Переходим на датчики.', true);
    } else if (status === 'ok') {
      this.speak('GPS снова доступен.', true);
    }
  }

  /** Предупреждение о превышении скорости */
  announceSpeedWarning(speedKmh: number, limitKmh: number) {
    if (!this.enabled) return;
    if (speedKmh > limitKmh + 15) {
      this.speak(`Впереди ограничение ${limitKmh} километров в час. Снизьте скорость.`, false);
    }
  }

  /** Предупреждение о камере / посте ДПС */
  announceCamera(distM: number, type: 'camera' | 'police' = 'camera') {
    if (!this.enabled) return;
    if (distM > 400 && distM <= 550) {
      const label = type === 'police' ? 'Пост ДПС' : 'Камера контроля скорости';
      this.speak(`Впереди ${label} через 500 метров.`);
    }
  }
}

export const voice = new VoiceAssistant();
