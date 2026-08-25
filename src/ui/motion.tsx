// Плавность: стрелка «я» едет между обновлениями, а панели появляются мягко.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

type Pose = { lat: number; lon: number; heading: number };

/**
 * Позиция приходит раз в секунду; рисуем её 20 раз в секунду, плавно перетекая
 * от старой к новой (курс — по кратчайшему повороту). Прыжки больше 300 м не сглаживаем.
 */
export function useSmoothPose(target: Pose | null, durationMs = 950): Pose | null {
  const [pose, setPose] = useState<Pose | null>(target);
  const from = useRef<Pose | null>(target);
  const cur = useRef<Pose | null>(target);
  useEffect(() => {
    if (!target) { setPose(null); cur.current = null; return; }
    const start = cur.current;
    const far = !start || Math.hypot((target.lat - start.lat) * 111320, (target.lon - start.lon) * 78000) > 300;
    if (far) { cur.current = target; setPose(target); return; }
    from.current = start;
    let dh = ((target.heading - start.heading + 540) % 360) - 180;
    const t0 = Date.now();
    const id = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / durationMs);
      const p = {
        lat: start.lat + (target.lat - start.lat) * k,
        lon: start.lon + (target.lon - start.lon) * k,
        heading: (start.heading + dh * k + 360) % 360,
      };
      cur.current = p;
      setPose(p);
      if (k >= 1) clearInterval(id);
    }, 50);
    return () => clearInterval(id);
  }, [target?.lat, target?.lon, target?.heading]);
  return pose;
}

/** Панель «выезжает» снизу (или сверху) с проявлением. Обёртка во весь экран, касания проходят насквозь. */
export function Appear({ children, from = 'bottom', style, delay = 0 }: { children: ReactNode; from?: 'bottom' | 'top' | 'fade'; style?: StyleProp<ViewStyle>; delay?: number }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(a, { toValue: 1, duration: 260, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);
  const shift = from === 'fade' ? 0 : from === 'bottom' ? 28 : -20;
  return (
    <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, style, { opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [shift, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}
