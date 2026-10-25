// Конфиг-плагин Expo: включение useLegacyPackaging для нативных библиотек jniLibs (opera-proxy)
const { withAppBuildGradle } = require('expo/config-plugins');

module.exports = function withOperaProxy(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes('useLegacyPackaging')) {
      cfg.modResults.contents += `
android {
    packagingOptions {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}
`;
    }
    return cfg;
  });
};
