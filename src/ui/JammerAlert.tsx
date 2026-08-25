// Карточка-оповещение о глушении GPS с практическими советами и действиями
// Показывается поверх карты при обнаружении глушилки или подмены GPS

import { useState } from 'react';
import { Pressable, Text, View, Linking } from 'react-native';
import type { NavState } from '../core/engine';
import { Icon } from './Icon';
import { Button } from './components';
import { C, themed, sz } from './theme';

interface JammerAlertProps {
  nav: NavState;
  onDismiss: () => void;
  onHere: () => void;
  onTurnNow: () => void;
}

export function JammerAlert({ nav, onDismiss, onHere, onTurnNow }: JammerAlertProps) {
  const [showInfo, setShowInfo] = useState(false);
  const isSpoofed = nav.gps === 'spoofed';
  
  const tips = isSpoofed ? [
    'Возможна попытка навигационного спуфинга',
    'Используем альтернативные источники определения местоположения',
    'Сравниваем данные с вышками сотовой связи и Wi-Fi',
    'Проверяем согласованность с датчиками движения',
  ] : [
    'Обнаружено активное подавление GPS сигнала',
    'Используем данные сотовых вышек для определения области',
    'Применяем данные Wi-Fi точек доступа',
    'Рассчитываем позицию по датчикам движения (акселерометр, гироскоп)',
  ];

  const recommendations = [
    '📍 При возможности покиньте зону глушения',
    '🚗 Двигайтесь осторожно, опирайтесь на дорожные знаки',
    '📱 Используйте кнопки коррекции позиции ниже',
    '⚠️ Не полагайтесь полностью на показания навигатора',
  ];

  return (
    <View style={s.overlay}>
      <View style={s.card}>
        {/* Заголовок с иконкой */}
        <View style={s.header}>
          <View style={[s.iconBox, isSpoofed ? s.iconBoxSpoofed : s.iconBoxJammed]}>
            <Icon 
              name={isSpoofed ? 'alert-circle' : 'satellite-variant'} 
              size={32} 
              color="#fff" 
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>
              {isSpoofed ? '⚠️ Подмена GPS' : '📡 Глушение GPS'}
            </Text>
            <Text style={s.subtitle}>
              {isSpoofed 
                ? 'Обнаружены несоответствия в координатах' 
                : 'Сигнал спутников заблокирован'}
            </Text>
          </View>
          <Pressable onPress={onDismiss} hitSlop={12}>
            <Icon name="close-circle" size={24} color={C.sub} />
          </Pressable>
        </View>

        {/* Текущий статус */}
        <View style={s.statusBox}>
          <View style={s.statusRow}>
            <Icon name="map-marker-radius" size={16} color={C.blue} />
            <Text style={s.statusLabel}>Метод определения:</Text>
            <Text style={s.statusValue}>{nav.mode}</Text>
          </View>
          <View style={s.statusRow}>
            <Icon name="crosshairs-gps" size={16} color={C.amber} />
            <Text style={s.statusLabel}>Точность:</Text>
            <Text style={s.statusValue}>±{Math.round(nav.sigma)}м</Text>
          </View>
          {nav.context && (
            <View style={s.statusRow}>
              <Icon name="information" size={16} color={C.green} />
              <Text style={s.statusLabel}>Источник:</Text>
              <Text style={s.statusValue}>{nav.context}</Text>
            </View>
          )}
        </View>

        {/* Как работает система */}
        <Pressable 
          style={s.infoToggle}
          onPress={() => setShowInfo(!showInfo)}
        >
          <Icon 
            name={showInfo ? 'chevron-up' : 'chevron-down'} 
            size={20} 
            color={C.blue} 
          />
          <Text style={s.infoToggleText}>
            {showInfo ? 'Скрыть детали' : 'Как мы определяем местоположение'}
          </Text>
        </Pressable>

        {showInfo && (
          <View style={s.infoBox}>
            {tips.map((tip, idx) => (
              <View key={idx} style={s.tipRow}>
                <View style={s.tipBullet}>
                  <Text style={s.tipBulletText}>{idx + 1}</Text>
                </View>
                <Text style={s.tipText}>{tip}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Рекомендации */}
        <View style={s.recommendations}>
          <Text style={s.recommendationsTitle}>💡 Рекомендации:</Text>
          {recommendations.map((rec, idx) => (
            <Text key={idx} style={s.recommendationText}>
              {rec}
            </Text>
          ))}
        </View>

        {/* Действия */}
        <View style={s.actions}>
          <Button 
            text="🎯 Я здесь"
            onPress={onHere}
            kind="secondary"
            style={{ flex: 1 }}
          />
          {!nav.walking && (
            <Button 
              text="↩️ Поворот"
              onPress={onTurnNow}
              kind="secondary"
              style={{ flex: 1 }}
            />
          )}
        </View>

        {/* Ссылка на справку */}
        <Pressable 
          style={s.helpLink}
          onPress={() => {
            // Здесь можно открыть справку или документацию
            Linking.openURL('https://example.com/gps-jamming-help');
          }}
        >
          <Icon name="help-circle-outline" size={16} color={C.blue} />
          <Text style={s.helpLinkText}>Подробнее о работе в условиях глушения</Text>
          <Icon name="open-in-new" size={14} color={C.blue} />
        </Pressable>
      </View>
    </View>
  );
}

const s = themed(() => ({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: sz(16),
    zIndex: 1000,
  },
  card: {
    backgroundColor: C.card,
    borderRadius: sz(24),
    padding: sz(20),
    width: '100%',
    maxWidth: sz(480),
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: sz(10) },
    elevation: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: sz(16),
  },
  iconBox: {
    width: sz(56),
    height: sz(56),
    borderRadius: sz(16),
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: sz(12),
  },
  iconBoxJammed: {
    backgroundColor: C.red,
  },
  iconBoxSpoofed: {
    backgroundColor: C.violet,
  },
  title: {
    fontSize: sz(20),
    fontWeight: '800',
    color: C.text,
    marginBottom: 2,
  },
  subtitle: {
    fontSize: sz(13),
    color: C.sub,
  },
  statusBox: {
    backgroundColor: C.blueSoft,
    borderRadius: sz(12),
    padding: sz(12),
    marginBottom: sz(12),
    gap: sz(8),
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: sz(8),
  },
  statusLabel: {
    fontSize: sz(13),
    color: C.sub,
    flex: 1,
  },
  statusValue: {
    fontSize: sz(13),
    fontWeight: '700',
    color: C.text,
  },
  infoToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: sz(8),
    marginBottom: sz(8),
    gap: sz(6),
  },
  infoToggleText: {
    fontSize: sz(14),
    fontWeight: '600',
    color: C.blue,
  },
  infoBox: {
    backgroundColor: C.cardAlt,
    borderRadius: sz(12),
    padding: sz(12),
    marginBottom: sz(12),
    gap: sz(10),
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  tipBullet: {
    width: sz(22),
    height: sz(22),
    borderRadius: sz(11),
    backgroundColor: C.blue,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: sz(10),
  },
  tipBulletText: {
    fontSize: sz(11),
    fontWeight: '700',
    color: '#fff',
  },
  tipText: {
    flex: 1,
    fontSize: sz(13),
    color: C.text,
    lineHeight: sz(18),
  },
  recommendations: {
    backgroundColor: C.warnSoft,
    borderRadius: sz(12),
    padding: sz(12),
    marginBottom: sz(12),
  },
  recommendationsTitle: {
    fontSize: sz(14),
    fontWeight: '700',
    color: C.warnText,
    marginBottom: sz(8),
  },
  recommendationText: {
    fontSize: sz(12),
    color: C.warnText,
    lineHeight: sz(18),
    marginBottom: sz(4),
  },
  actions: {
    flexDirection: 'row',
    gap: sz(10),
    marginBottom: sz(12),
  },
  helpLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: sz(8),
    gap: sz(6),
  },
  helpLinkText: {
    fontSize: sz(12),
    color: C.blue,
    flex: 1,
    textAlign: 'center',
  },
}));
