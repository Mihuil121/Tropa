// Временная панель отладки (кнопка 🐞): показывает журнал и даёт отправить его в Telegram.

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Switch, Text, View, Animated } from 'react-native';
import { getLines, subscribe } from '../debugLog';
import { checkNetworkHosts, type HostCheckResult } from '../net';
import { C, themed, sz } from './theme';
import { Icon } from './Icon';

export function DebugPanel({ onClose, jam, onJam }: { onClose: () => void; jam: boolean; onJam: (v: boolean) => void }) {
  const [, setTick] = useState(0);
  const ref = useRef<any>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [checkingNet, setCheckingNet] = useState(false);
  const [netResults, setNetResults] = useState<HostCheckResult[] | null>(null);

  useEffect(() => {
    subscribe(() => setTick((x) => x + 1));
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, []);

  const runNetCheck = async () => {
    setCheckingNet(true);
    setNetResults(null);
    try {
      const res = await checkNetworkHosts();
      setNetResults(res);
    } catch {} finally {
      setCheckingNet(false);
    }
  };

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
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Pressable
            onPress={runNetCheck}
            disabled={checkingNet}
            style={({ pressed }) => [s.btn, pressed && { opacity: 0.7 }]}
          >
            <Icon name="web" size={16} color="#6d8bff" style={{ marginRight: 4 }} />
            <Text style={s.btnText}>{checkingNet ? 'Проверка…' : 'Проверить сеть'}</Text>
          </Pressable>
          <Pressable 
            onPress={() => Share.share({ message: lines.join('\n') })} 
            style={({ pressed }) => [s.btn, pressed && { opacity: 0.7 }]}
          >
            <Icon name="share-variant-outline" size={16} color="#6d8bff" style={{ marginRight: 4 }} />
            <Text style={s.btnText}>Лог</Text>
          </Pressable>
          <Pressable 
            onPress={onClose} 
            style={({ pressed }) => [s.closeBtn, pressed && { opacity: 0.7 }]}
          >
            <Icon name="close" size={18} color="#fff" />
          </Pressable>
        </View>
      </View>

      {netResults && (
        <View style={s.netBox}>
          <Text style={s.netTitle}>Доступность серверов:</Text>
          <ScrollView style={{ maxHeight: sz(130) }} showsVerticalScrollIndicator={false}>
            {netResults.map((r, i) => (
              <View key={i} style={s.netRow}>
                <Text style={{ color: r.ok ? '#40c057' : '#fa5252', fontWeight: '800', marginRight: 6 }}>
                  {r.ok ? '✓' : '✗'}
                </Text>
                <Text style={{ color: '#fff', fontSize: sz(12), flex: 1 }} numberOfLines={1}>
                  {r.name} ({r.ms} мс)
                </Text>
                <Text style={{ color: r.ok ? '#82c91e' : '#ff8787', fontSize: sz(11) }} numberOfLines={1}>
                  {r.ok ? `HTTP ${r.status}` : (r.error || 'ошибка')}
                </Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

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
    marginBottom: sz(12),
    paddingBottom: sz(8),
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
    fontSize: sz(16),
    fontWeight: '800',
  },
  badge: {
    backgroundColor: '#6d8bff',
    borderRadius: sz(10),
    paddingHorizontal: sz(8),
    paddingVertical: 2,
    marginLeft: sz(6),
  },
  badgeText: {
    color: '#fff',
    fontSize: sz(11),
    fontWeight: '700',
  },
  btn: { 
    backgroundColor: 'rgba(109,139,255,0.15)',
    borderRadius: sz(10), 
    paddingHorizontal: sz(8),
    paddingVertical: sz(6),
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(109,139,255,0.3)',
  },
  btnText: { 
    color: '#6d8bff', 
    fontSize: sz(12),
    fontWeight: '600',
  },
  closeBtn: {
    backgroundColor: '#ff6b6b',
    borderRadius: sz(10),
    width: sz(32),
    height: sz(32),
    alignItems: 'center',
    justifyContent: 'center',
  },
  netBox: {
    backgroundColor: 'rgba(109,139,255,0.1)',
    borderRadius: sz(12),
    padding: sz(10),
    marginBottom: sz(12),
    borderWidth: 1,
    borderColor: 'rgba(109,139,255,0.2)',
  },
  netTitle: {
    color: '#fff',
    fontSize: sz(13),
    fontWeight: '700',
    marginBottom: sz(6),
  },
  netRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: sz(2),
  },
  jam: { 
    flexDirection: 'row', 
    alignItems: 'center',
    backgroundColor: 'rgba(255,107,107,0.08)', 
    borderRadius: sz(14),
    padding: sz(12),
    marginBottom: sz(12),
    borderWidth: 1,
    borderColor: 'rgba(255,107,107,0.2)',
  },
  jamIconBox: {
    width: sz(36),
    height: sz(36),
    borderRadius: sz(10),
    backgroundColor: 'rgba(255,107,107,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: sz(10),
  },
  jamTitle: { 
    color: '#fff', 
    fontSize: sz(14),
    fontWeight: '800',
    marginBottom: sz(2),
  },
  jamSub: { 
    color: '#aab3c0', 
    fontSize: sz(11),
    lineHeight: sz(15),
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: sz(6),
    paddingHorizontal: sz(10),
    backgroundColor: 'rgba(109,139,255,0.08)',
    borderRadius: sz(8),
    marginBottom: sz(6),
  },
  logHeaderText: {
    color: '#6d8bff',
    fontSize: sz(11),
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  logLine: {
    paddingVertical: sz(3),
    paddingHorizontal: sz(6),
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
    lineHeight: sz(15),
  },
}));
