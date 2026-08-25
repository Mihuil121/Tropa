// Временная панель отладки (кнопка 🐞): показывает журнал и даёт отправить его в Telegram.

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Switch, Text, View, Animated } from 'react-native';
import { getLines, subscribe } from '../debugLog';
import { C, themed, sz } from './theme';
import { Icon } from './Icon';

export function DebugPanel({ onClose, jam, onJam }: { onClose: () => void; jam: boolean; onJam: (v: boolean) => void }) {
  const [, setTick] = useState(0);
  const ref = useRef<any>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    subscribe(() => setTick((x) => x + 1));
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, []);
  
  const lines = getLines();

  return (
    <Animated.View style={[s.root, { opacity: fadeAnim }]}>
      <View style={s.head}>
        <View style={s.titleBox}>
          <Icon name="bug" size={18} color="#6d8bff" style={{ marginRight: 8 }} />
          <Text style={s.title}>Журнал отладки</Text>
          <View style={s.badge}>
            <Text style={s.badgeText}>{lines.length}</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable 
            onPress={() => Share.share({ message: lines.join('\n') })} 
            style={({ pressed }) => [s.btn, pressed && { opacity: 0.7 }]}
          >
            <Icon name="share-variant-outline" size={16} color="#6d8bff" style={{ marginRight: 4 }} />
            <Text style={s.btnText}>Поделиться</Text>
          </Pressable>
          <Pressable 
            onPress={onClose} 
            style={({ pressed }) => [s.closeBtn, pressed && { opacity: 0.7 }]}
          >
            <Icon name="close" size={18} color="#fff" />
          </Pressable>
        </View>
      </View>
      
      <View style={s.jam}>
        <View style={s.jamIconBox}>
          <Icon name="satellite-variant" size={20} color="#ff6b6b" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.jamTitle}>🧪 Тест глушения GPS</Text>
          <Text style={s.jamSub}>
            Симулирует работу глушилки. Приложение перестанет доверять спутникам 
            и будет определять место по вышкам, Wi‑Fi и датчикам движения.
          </Text>
          <Text style={[s.jamSub, { marginTop: 6, fontWeight: '600' }]}>
            ⚠️ Не отключайте геолокацию в настройках — тогда Android блокирует все источники данных
          </Text>
        </View>
        <Switch 
          value={jam} 
          onValueChange={onJam}
          trackColor={{ false: '#4a536b', true: '#ff6b6b' }}
          thumbColor={jam ? '#fff' : '#9aa6b8'}
        />
      </View>
      
      <View style={s.logHeader}>
        <Icon name="text-box-outline" size={14} color="#6d8bff" style={{ marginRight: 6 }} />
        <Text style={s.logHeaderText}>События системы</Text>
      </View>
      
      <ScrollView 
        ref={ref} 
        style={{ flex: 1 }} 
        onContentSizeChange={() => ref.current?.scrollToEnd({ animated: false })}
        showsVerticalScrollIndicator={false}
      >
        {lines.map((l, i) => {
          const isError = l.includes('❌');
          const isWarning = l.includes('⚠');
          return (
            <View key={i} style={[s.logLine, (isError || isWarning) && s.logLineHighlight]}>
              <Text 
                style={[
                  s.line, 
                  isError && { color: '#ff8787' }, 
                  isWarning && { color: '#ffd43b' }
                ]} 
                selectable
              >
                {l}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </Animated.View>
  );
}

const s = themed(() => ({
  root: { 
    position: 'absolute', 
    top: sz(40), 
    left: sz(8), 
    right: sz(8), 
    bottom: sz(8), 
    backgroundColor: 'rgba(15,20,30,0.98)', 
    borderRadius: sz(20), 
    padding: sz(16), 
    zIndex: 9999, 
    elevation: 9999,
    borderWidth: 1,
    borderColor: 'rgba(109,139,255,0.2)',
  },
  head: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'space-between',
    marginBottom: sz(16),
    paddingBottom: sz(12),
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(109,139,255,0.15)',
  },
  titleBox: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  title: { 
    color: '#fff', 
    fontSize: sz(17), 
    fontWeight: '800',
  },
  badge: {
    backgroundColor: '#6d8bff',
    borderRadius: sz(10),
    paddingHorizontal: sz(8),
    paddingVertical: 2,
    marginLeft: sz(8),
  },
  badgeText: {
    color: '#fff',
    fontSize: sz(11),
    fontWeight: '700',
  },
  btn: { 
    backgroundColor: 'rgba(109,139,255,0.15)',
    borderRadius: sz(10), 
    paddingHorizontal: sz(12), 
    paddingVertical: sz(8),
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(109,139,255,0.3)',
  },
  btnText: { 
    color: '#6d8bff', 
    fontSize: sz(13),
    fontWeight: '600',
  },
  closeBtn: {
    backgroundColor: '#ff6b6b',
    borderRadius: sz(10),
    width: sz(36),
    height: sz(36),
    alignItems: 'center',
    justifyContent: 'center',
  },
  jam: { 
    flexDirection: 'row', 
    alignItems: 'flex-start', 
    backgroundColor: 'rgba(255,107,107,0.08)', 
    borderRadius: sz(16), 
    padding: sz(14),
    marginBottom: sz(16),
    borderWidth: 1,
    borderColor: 'rgba(255,107,107,0.2)',
  },
  jamIconBox: {
    width: sz(40),
    height: sz(40),
    borderRadius: sz(12),
    backgroundColor: 'rgba(255,107,107,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: sz(12),
  },
  jamTitle: { 
    color: '#fff', 
    fontSize: sz(15), 
    fontWeight: '800',
    marginBottom: sz(4),
  },
  jamSub: { 
    color: '#aab3c0', 
    fontSize: sz(12), 
    lineHeight: sz(17),
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: sz(8),
    paddingHorizontal: sz(12),
    backgroundColor: 'rgba(109,139,255,0.08)',
    borderRadius: sz(8),
    marginBottom: sz(8),
  },
  logHeaderText: {
    color: '#6d8bff',
    fontSize: sz(12),
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  logLine: {
    paddingVertical: sz(4),
    paddingHorizontal: sz(8),
    borderRadius: sz(6),
    marginBottom: 1,
  },
  logLineHighlight: {
    backgroundColor: 'rgba(255,215,0,0.05)',
  },
  line: { 
    color: '#d0d7e2', 
    fontSize: sz(11), 
    fontFamily: 'monospace',
    lineHeight: sz(16),
  },
}));
