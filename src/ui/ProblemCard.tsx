// «ДТП на маршруте через 3,2 км» — с кнопкой объезда (данные Waze, неофициально).

import { Pressable, Text, View } from 'react-native';
import type { RouteProblem } from '../waze';
import { fmtDistance, fmtDuration } from '../online';
import { Icon } from './Icon';
import { C, shadow, themed, sz } from './theme';

export function ProblemCard({ p, busy, onAvoid, onSkip }: { p: RouteProblem; busy: boolean; onAvoid: () => void; onSkip: () => void }) {
  const jam = p.kind === 'jam';
  const iconName = jam 
    ? 'car-multiple' 
    : p.label === 'Перекрыто' 
    ? 'road-variant' 
    : 'car-emergency';
  
  return (
    <View style={[s.card, { borderColor: jam ? '#f76707' : '#e03131' }]}>
      <View style={[s.badge, { backgroundColor: jam ? '#f76707' : '#e03131' }]}>
        <Icon name={iconName} size={24} color="#fff" />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
          <Icon 
            name="alert" 
            size={14} 
            color={jam ? '#f76707' : '#e03131'} 
            style={{ marginRight: 4 }} 
          />
          <Text style={s.title} numberOfLines={1}>
            {p.label}
          </Text>
        </View>
        <View style={s.details}>
          <View style={s.detailItem}>
            <Icon name="map-marker-distance" size={12} color={C.sub} />
            <Text style={s.detailText}>через {fmtDistance(p.distM)}</Text>
          </View>
          {jam && p.delayS > 60 && (
            <View style={s.detailItem}>
              <Icon name="clock-outline" size={12} color={C.sub} />
              <Text style={s.detailText}>+{fmtDuration(p.delayS)}</Text>
            </View>
          )}
        </View>
        {p.street && (
          <Text style={s.street} numberOfLines={1}>
            📍 {p.street}
          </Text>
        )}
        <Text style={s.source}>
          Источник: {p.source ?? 'Waze'}
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        <Pressable 
          onPress={onAvoid} 
          disabled={busy} 
          style={({ pressed }) => [
            s.go, 
            (pressed || busy) && { opacity: 0.7 },
            busy && { backgroundColor: C.amber }
          ]}
        >
          {busy ? (
            <Icon name="loading" size={16} color="#fff" />
          ) : (
            <Icon name="directions" size={16} color="#fff" />
          )}
          <Text style={s.goText}>{busy ? 'Ищу' : 'Объезд'}</Text>
        </Pressable>
        <Pressable 
          onPress={onSkip} 
          hitSlop={10} 
          style={({ pressed }) => [
            s.skipBtn,
            pressed && { backgroundColor: C.chip }
          ]}
        >
          <Icon name="close" size={16} color={C.sub} />
          <Text style={s.skipText}>Пропустить</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = themed(() => ({
  card: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    backgroundColor: C.card, 
    borderRadius: sz(20), 
    padding: sz(14), 
    borderWidth: 2, 
    marginBottom: sz(8), 
    ...shadow,
    elevation: 10,
  },
  badge: { 
    width: sz(48), 
    height: sz(48), 
    borderRadius: sz(14), 
    alignItems: 'center', 
    justifyContent: 'center', 
    marginRight: sz(12),
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  title: { 
    fontSize: sz(16), 
    fontWeight: '800', 
    color: C.text,
  },
  details: {
    flexDirection: 'row',
    gap: sz(12),
    marginTop: sz(4),
    marginBottom: 2,
  },
  detailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: sz(4),
  },
  detailText: {
    fontSize: sz(12),
    fontWeight: '600',
    color: C.sub,
  },
  street: {
    fontSize: sz(11),
    color: C.hint,
    marginTop: 2,
  },
  source: {
    fontSize: sz(10),
    color: C.hint,
    marginTop: 2,
  },
  go: { 
    backgroundColor: C.blue, 
    borderRadius: sz(12), 
    paddingHorizontal: sz(16), 
    paddingVertical: sz(10),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: sz(6),
    minWidth: sz(90),
    shadowColor: C.blue,
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  goText: { 
    color: '#fff', 
    fontWeight: '800', 
    fontSize: sz(13),
  },
  skipBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: sz(4),
    paddingHorizontal: sz(12),
    paddingVertical: sz(6),
    borderRadius: sz(10),
  },
  skipText: {
    fontSize: sz(11),
    color: C.sub,
    fontWeight: '600',
  },
}));
