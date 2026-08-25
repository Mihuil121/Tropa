// Как сейчас используется телефон. От этого зависит, каким датчикам можно верить.
//
//   Держат ли:  'fixed' — лежит/закреплён (направление «вниз» почти не меняется)
//               'hand'  — в руке (постоянно чуть наклоняется и поворачивается)
//   Движение:   'walking' — человек идёт (ритмичные шаги 1–3 в секунду)
//               'vehicle' — едем (скорость без шагов; держится, пока не появятся шаги)
//               'still'   — стоим на месте пешком
//               'unknown' — пока непонятно
//
// Почему это важно:
//   - в руке гироскоп видит повороты руки, а не машины — для курса машины он бесполезен;
//   - в руке и при ходьбе тряска ничего не говорит о скорости машины;
//   - при ходьбе работают шаги: шаги × длина шага = пройденный путь.

export type Holding = 'fixed' | 'hand';
export type Movement = 'still' | 'walking' | 'vehicle' | 'unknown';

export class ContextDetector {
  holding: Holding = 'fixed';
  movement: Movement = 'unknown';
  cadence = 0; // шагов в секунду

  private steps: number[] = [];
  private tilts: number[] = [];
  private noStepsSince = 0;

  onStep(t: number) {
    this.steps.push(t);
    while (this.steps.length && t - this.steps[0] > 6) this.steps.shift();
  }

  /** Раз в секунду. tiltRate — как быстро меняется направление «вниз», °/с. */
  onSecond(t: number, tiltRate: number, gpsSpeed: number | null) {
    // --- в руке или лежит: медиана за 5 с, с гистерезисом, чтобы не дёргалось ---
    this.tilts.push(tiltRate);
    if (this.tilts.length > 5) this.tilts.shift();
    const med = [...this.tilts].sort((a, b) => a - b)[this.tilts.length >> 1];
    if (this.holding === 'fixed' && med > 2.5) this.holding = 'hand';
    else if (this.holding === 'hand' && med < 1.2) this.holding = 'fixed';

    // --- шаги: сколько за последние 4 с и насколько ритмично ---
    const recent = this.steps.filter((s) => t - s <= 4);
    this.cadence = recent.length / 4;
    let rhythmic = false;
    if (recent.length >= 4) {
      const iv = recent.slice(1).map((s, i) => s - recent[i]);
      const m = iv.reduce((a, b) => a + b, 0) / iv.length;
      const sd = Math.sqrt(iv.reduce((a, b) => a + (b - m) ** 2, 0) / iv.length);
      rhythmic = m > 0.3 && m < 1.0 && sd < 0.15; // кочки в машине не бывают ритмичными
    }

    if (rhythmic) {
      this.movement = 'walking';
      this.noStepsSince = t;
      return;
    }
    if (gpsSpeed !== null && gpsSpeed > 4) { this.movement = 'vehicle'; return; }
    if (gpsSpeed !== null && gpsSpeed < 1.5) { this.movement = 'still'; return; }
    if (this.movement === 'walking' && t - this.noStepsSince > 5) {
      this.movement = gpsSpeed !== null && gpsSpeed > 2.5 ? 'vehicle' : 'still';
    }
    // 'vehicle' держится, пока не пойдут шаги: на светофоре мы всё ещё в машине
  }

  get label(): string {
    if (this.movement === 'walking') return 'Пешком';
    if (this.movement === 'still') return 'Стоим (пешком)';
    if (this.movement === 'vehicle') return this.holding === 'hand' ? 'В машине, телефон в руке' : 'В машине, телефон лежит';
    return this.holding === 'hand' ? 'Телефон в руке' : 'Телефон лежит';
  }
}
