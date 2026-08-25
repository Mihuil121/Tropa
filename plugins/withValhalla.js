// Конфиг-плагин Expo: встроенный Valhalla (modules/valhalla-router).
// Библиотека valhalla-mobile объявляет minSdk 26 (Android 8), а приложение поддерживает
// Android 7 (API 24). Разрешаем сборку через tools:overrideLibrary — на Android 7 модуль
// сам отвечает «не поддерживается», и маршруты строятся как раньше (сервер / офлайн-граф).
const { withAndroidManifest } = require('expo/config-plugins');

const LIBS = ['com.valhalla.valhalla', 'com.valhalla.api', 'com.valhalla.config'];

module.exports = function withValhalla(config) {
  return withAndroidManifest(config, (cfg) => {
    const m = cfg.modResults.manifest;
    m.$ = m.$ ?? {};
    m.$['xmlns:tools'] = m.$['xmlns:tools'] ?? 'http://schemas.android.com/tools';
    const sdk = (m['uses-sdk'] ??= [{ $: {} }])[0];
    sdk.$ = sdk.$ ?? {};
    const have = new Set(String(sdk.$['tools:overrideLibrary'] ?? '').split(',').filter(Boolean));
    LIBS.forEach((l) => have.add(l));
    sdk.$['tools:overrideLibrary'] = [...have].join(',');
    return cfg;
  });
};
