// «Области без интернета»: карта, дороги и поиск адресов целой области с сервера данных
// в России. После скачивания маршрут строится прямо в телефоне — без сети и без VPN.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { LatLon } from '../core/geo';
import { DEFAULT_DATA_URL, deviceRoutingAvailable, fetchManifest, installRegion, installedRegions, loadRegions, removeRegion, subscribeRegions, type InstallProgress } from '../regions';
import { fmtBytes, inBbox, PART_LABEL, PARTS, type InstalledRegion, type Manifest, type Part, type RemoteRegion } from '../regionsCore';
import type { Settings } from '../data';
import { Button } from './components';
import { Icon } from './Icon';
import { C, PANEL_W, compact, sz, themed, ui, useWide } from './theme';

export function RegionsSheet({ near, settings, onSettings, onClose, onToast }: {
  near?: LatLon; settings: Settings; onSettings: (s: Settings) => void; onClose: () => void; onToast: (t: string) => void;
}) {
  const { wide } = useWide();
  const [url, setUrl] = useState(settings.dataUrl ?? DEFAULT_DATA_URL);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [installed, setInstalled] = useState<InstalledRegion[]>(installedRegions());
  const [busy, setBusy] = useState<{ id: string; p: InstallProgress } | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    loadRegions().then(setInstalled);
    return subscribeRegions(() => setInstalled(installedRegions()));
  }, []);

  const load = async (u: string) => {
    if (!u.trim()) { setManifest(null); setErr(''); return; }
    setLoading(true); setErr('');
    try { setManifest(await fetchManifest(u)); }
    catch (e: any) { setManifest(null); setErr(String(e?.message ?? e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(url); }, []);

  const saveUrl = () => {
    if ((settings.dataUrl ?? '') !== url.trim()) onSettings({ ...settings, dataUrl: url.trim() });
    load(url);
  };

  const start = async (r: RemoteRegion, parts: Part[]) => {
    if (busy) return;
    const c = new AbortController();
    ctrl.current = c;
    setBusy({ id: r.id, p: { part: parts[0], pct: 0 } });
    try {
      await installRegion(r, parts, (p) => setBusy({ id: r.id, p }), c.signal);
      onToast(`«${r.name}» скачана: теперь маршруты и поиск работают без интернета`);
    } catch (e: any) {
      if (!c.signal.aborted) onToast(`«${r.name}»: не удалось скачать — ${e?.message ?? e}`);
    } finally { setBusy(null); ctrl.current = null; }
  };

  const regions = [...(manifest?.regions ?? [])].sort((a, b) => Number(!!near && inBbox(b.bbox, near)) - Number(!!near && inBbox(a.bbox, near)) || a.name.localeCompare(b.name));
  const orphan = installed.filter((i) => !regions.some((r) => r.id === i.id));
  const engineOk = deviceRoutingAvailable();

  const row = (r: RemoteRegion) => {
    const inst = installed.find((i) => i.id === r.id);
    const have = PARTS.filter((p) => inst?.files[p]);
    const avail = PARTS.filter((p) => r[p]);
    const missing = avail.filter((p) => !inst?.files[p]);
    const outdated = !!inst && !!r.version && !!inst.version && r.version !== inst.version;
    const total = avail.reduce((a, p) => a + (r[p]?.bytes ?? 0), 0);
    const here = !!near && inBbox(r.bbox, near);
    const isBusy = busy?.id === r.id;
    return (
      <View key={r.id} style={s.row}>
        <View style={{ flex: 1 }}>
          <Text style={s.name} numberOfLines={1}>{r.name}{here ? ' · вы здесь' : ''}</Text>
          <Text style={s.detail} numberOfLines={2}>
            {isBusy ? `Качается ${PART_LABEL[busy!.p.part]}: ${Math.floor(busy!.p.pct)}%`
              : have.length ? `Скачано: ${have.map((p) => PART_LABEL[p]).join(', ')}${outdated ? ' · есть обновление' : ''}`
              : `${avail.map((p) => PART_LABEL[p]).join(', ')} · ${fmtBytes(total)}`}
          </Text>
          {isBusy && <View style={s.bar}><View style={[s.fill, { width: `${Math.min(100, busy!.p.pct)}%` }]} /></View>}
        </View>
        {isBusy ? (
          <Pressable hitSlop={10} style={s.iconBtn} onPress={() => ctrl.current?.abort()}><Icon name="close" size={sz(22)} color={C.sub} /></Pressable>
        ) : (
          <>
            {(missing.length > 0 || outdated) && (
              <Pressable hitSlop={8} style={s.dl} onPress={() => start(r, outdated ? avail : missing)}>
                <Icon name={outdated ? 'update' : 'download'} size={sz(20)} color="#fff" />
              </Pressable>
            )}
            {!!inst && (
              <Pressable hitSlop={8} style={s.iconBtn} onPress={() => removeRegion(r.id).then(() => onToast(`«${r.name}» удалена`))}>
                <Icon name="trash-can-outline" size={sz(22)} color={C.red} />
              </Pressable>
            )}
          </>
        )}
      </View>
    );
  };

  return (
    <View style={[s.root, wide && { right: undefined, width: PANEL_W + 40, borderTopRightRadius: 24, borderBottomRightRadius: 24 }]}>
      <View style={s.head}>
        <Pressable onPress={onClose} hitSlop={12} style={{ marginRight: 12 }}><Icon name="arrow-left" size={sz(26)} color={C.text} /></Pressable>
        <Text style={ui.h1}>Области без интернета</Text>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: sz(40) }}>
        {!compact && (
          <Text style={[ui.sub, s.p]}>
            Скачайте область один раз (лучше по Wi‑Fi) — и в ней без интернета и VPN будут работать карта,
            прокладка маршрута с подсказками и поиск адресов.
          </Text>
        )}
        {!engineOk && (
          <View style={s.warn}>
            <Icon name="alert-outline" size={sz(18)} color={C.warnText} style={{ marginRight: 8 }} />
            <Text style={[ui.sub, { color: C.warnText, flex: 1 }]}>
              Встроенные маршруты на этом телефоне недоступны (нужен Android 8+). Карта и поиск адресов всё равно будут работать без сети.
            </Text>
          </View>
        )}

        <Text style={s.group}>СЕРВЕР ДАННЫХ</Text>
        <View style={s.urlRow}>
          <TextInput style={s.input} value={url} onChangeText={setUrl} onSubmitEditing={saveUrl} autoCapitalize="none" autoCorrect={false}
            placeholder="https://storage.yandexcloud.net/…/" placeholderTextColor={C.hint} keyboardType="url" returnKeyType="done" />
          <Pressable hitSlop={8} onPress={saveUrl} style={{ padding: sz(6) }}><Icon name="refresh" size={sz(22)} color={C.blue} /></Pressable>
        </View>
        {loading && <ActivityIndicator style={{ marginTop: sz(14) }} color={C.blue} />}
        {!!err && <Text style={[ui.sub, s.p, { color: C.redText }]}>Сервер данных не ответил: {err}</Text>}
        {!url.trim() && !loading && (
          <Text style={[ui.sub, s.p]}>Адрес сервера не задан. Его даёт разработчик приложения (файл manifest.json с областями).</Text>
        )}

        {regions.length > 0 && <Text style={s.group}>ОБЛАСТИ{manifest?.updated ? ` · данные от ${manifest.updated}` : ''}</Text>}
        {regions.map(row)}

        {orphan.length > 0 && <Text style={s.group}>СКАЧАНО РАНЕЕ</Text>}
        {orphan.map((i) => (
          <View key={i.id} style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{i.name}</Text>
              <Text style={s.detail}>{PARTS.filter((p) => i.files[p]).map((p) => PART_LABEL[p]).join(', ')}</Text>
            </View>
            <Pressable hitSlop={8} style={s.iconBtn} onPress={() => removeRegion(i.id)}><Icon name="trash-can-outline" size={sz(22)} color={C.red} /></Pressable>
          </View>
        ))}

        {manifest && regions.some((r) => near && inBbox(r.bbox, near) && !installed.some((i) => i.id === r.id)) && (
          <View style={{ marginHorizontal: sz(16), marginTop: sz(16), flexDirection: 'row' }}>
            <Button text="Скачать область, где я сейчас" onPress={() => { const r = regions.find((x) => near && inBbox(x.bbox, near)); if (r) start(r, PARTS.filter((p) => r[p])); }} />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = themed(() => ({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.card, paddingTop: sz(44), elevation: 30, zIndex: 30 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: sz(16), paddingBottom: sz(6) },
  p: { marginHorizontal: sz(16), marginVertical: sz(6), lineHeight: sz(19) },
  warn: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: C.warnSoft, borderRadius: sz(12), padding: sz(10), marginHorizontal: sz(16), marginTop: sz(8) },
  group: { fontSize: sz(11), fontWeight: '700', color: C.hint, letterSpacing: 0.6, marginTop: sz(18), marginBottom: 2, marginHorizontal: sz(16) },
  urlRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.chip, borderRadius: sz(14), paddingHorizontal: sz(12), height: sz(48), marginHorizontal: sz(16), marginTop: sz(6) },
  input: { flex: 1, fontSize: sz(14), color: C.text },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: sz(16), paddingVertical: sz(11), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  name: { fontSize: sz(16), fontWeight: '600', color: C.text },
  detail: { fontSize: sz(13), color: C.sub, marginTop: 2 },
  bar: { height: sz(5), backgroundColor: C.line, borderRadius: 3, marginTop: sz(6), overflow: 'hidden' },
  fill: { height: sz(5), backgroundColor: C.blue },
  dl: { width: sz(38), height: sz(38), borderRadius: sz(19), backgroundColor: C.blue, alignItems: 'center', justifyContent: 'center', marginLeft: sz(8) },
  iconBtn: { padding: sz(8), marginLeft: sz(4) },
}));
