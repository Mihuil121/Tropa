// Индикатор статуса GPS: показывает текущее состояние сигнала в реальном времени
// Расположен в правом верхнем углу карты, меняет цвет в зависимости от качества сигнала

import { useState, useEffect } from 'react';
import { Pressable, Text, View, Animated } from 'react-native';
import type { NavState } from '../core/engine';
import { Icon } from './Icon';
import { C, GPS_LABEL, themed, sz } from './theme';

export function GpsStatusIndicator({ nav, onPress }: { nav: NavState | null; onPress?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const pulseAnim = useState(() => new Animated.Value(1))[0];
  
  const gpsState = nav ? GPS_LABEL[nav.gps] : GPS_LABEL.none;
  const isOk = nav?.gps === 'ok';
  const hasProblem = nav?.gps === 'jammed' || nav?.gps === 'spoofed';

  useEffect(() => {
    if (!hasProblem) return;
    
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    );
    
    pulse.start();
    return () => pulse.stop();
  }, [hasProblem]);

  const icon = nav?.gps === 'spoofed' 
    ? 'alert-circle' 
    : nav?.gps === 'jammed'
    ? 'satellite-variant'
    : nav?.gps === 'ok'
    ? 'check-circle'
    : nav?.gps === 'checking'
    ? 'timer-sand'
    : 'satellite-variant';

  const bgColor = isOk 
    ? 'rgba(31, 138, 76, 0.95)' 
    : hasProblem 
    ? 'rgba(214, 69, 69, 0.95)' 
    : 'rgba(201, 138, 0, 0.95)';

  const handlePress = () => {
    setExpanded(!expanded);
    onPress?.();
  };

  return (
    <Pressable onPress={handlePress} style={({ pressed }) => [pressed && { opacity: 0.8 }]}>
      <Animated.View 
        style={[
          s.container,
          { backgroundColor: bgColor },
          hasProblem && { transform: [{ scale: pulseAnim }] }
        ]}
      >
        <View style={s.compact}>
          <Icon name={icon} size={18} color="#fff" />
          {hasProblem && (
            <View style={s.alertDot}>
              <View style={s.alertDotInner} />
            </View>
          )}
        </View>
        
        {expanded && nav && (
          <View style={s.expanded}>
            <Text style={s.statusText}>{gpsState.text}</Text>
            {nav.ready && (
              <>
                <View style={s.divider} />
                <View style={s.statRow}>
                  <Text style={s.statLabel}>Точность:</Text>
                  <Text style={s.statValue}>±{Math.round(nav.sigma)}м</Text>
                </View>
                {nav.speedKmh > 0 && (
                  <View style={s.statRow}>
                    <Text style={s.statLabel}>Скорость:</Text>
                    <Text style={s.statValue}>{Math.round(nav.speedKmh)} км/ч</Text>
                  </View>
                )}
                {nav.context && (
                  <View style={s.statRow}>
                    <Text style={s.statLabel}>Источник:</Text>
                    <Text style={s.statValue}>{nav.context}</Text>
                  </View>
                )}
              </>
            )}
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
}

const s = themed(() => ({
  container: {
    borderRadius: sz(16),
    paddingHorizontal: sz(12),
    paddingVertical: sz(10),
    minWidth: sz(48),
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 8,
  },
  compact: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: sz(10),
    height: sz(10),
    borderRadius: sz(5),
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertDotInner: {
    width: sz(6),
    height: sz(6),
    borderRadius: sz(3),
    backgroundColor: '#ff1f1f',
  },
  expanded: {
    marginTop: sz(10),
    paddingTop: sz(10),
    minWidth: sz(180),
  },
  statusText: {
    fontSize: sz(13),
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: sz(8),
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.3)',
    marginVertical: sz(8),
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: sz(4),
  },
  statLabel: {
    fontSize: sz(11),
    color: 'rgba(255,255,255,0.8)',
  },
  statValue: {
    fontSize: sz(11),
    fontWeight: '700',
    color: '#fff',
  },
}));
