// Конфиг-плагин Expo: при `expo prebuild` кладёт шрифты карты (assets/glyphs)
// внутрь APK (android/app/src/main/assets/glyphs). Стиль карты читает их как
// asset://glyphs/{fontstack}/{range}.pbf — подписи на карте работают без интернета.
const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withGlyphs(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'assets', 'glyphs');
      const dst = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'assets', 'glyphs');
      fs.cpSync(src, dst, { recursive: true });
      return cfg;
    },
  ]);
};
