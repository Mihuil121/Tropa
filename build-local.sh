#!/usr/bin/env bash
# Сборка APK «Тропы» на Linux (через прокси порт 18080)
# Запуск из папки проекта: bash build-local.sh

set -euo pipefail

PROJ="$(cd "$(dirname "$0")" && pwd)"

echo "=== Настройка HTTP-прокси (127.0.0.1:18080) ==="
export http_proxy="http://127.0.0.1:18080"
export https_proxy="http://127.0.0.1:18080"
export HTTP_PROXY="http://127.0.0.1:18080"
export HTTPS_PROXY="http://127.0.0.1:18080"

npm config set proxy http://127.0.0.1:18080
npm config set https-proxy http://127.0.0.1:18080

unset ANDROID_PREFS_ROOT || true

echo "=== 1. Проверка Node.js ==="
node -v

echo -e "\n=== 2. Java 21 (нужна встроенному Valhalla; если нет — пробуем 17) ==="
if [ -d "$HOME/.jdks/jdk21" ]; then export JAVA_HOME="$HOME/.jdks/jdk21"
else echo "⚠ Нет $HOME/.jdks/jdk21 — беру JDK 17. Если сборка упадёт на valhalla-mobile («class file version 65»), поставьте JDK 21."; export JAVA_HOME="$HOME/.jdks/jdk17"; fi
export PATH="$JAVA_HOME/bin:$PATH"
java -version

echo -e "\n=== 3. Android SDK ==="
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

echo -e "\n=== 4. Зависимости проекта (npm) ==="
cd "$PROJ"
npm ci

echo -e "\n=== 5. Генерация Android-проекта ==="
export CI=1
npx expo prebuild --platform android --no-install
echo "sdk.dir=$ANDROID_HOME" > "$PROJ/android/local.properties"

echo -e "\n=== 5.1. Настройка android/settings.gradle и прокси в gradle.properties ==="
cat << 'EOF' > "$PROJ/android/settings.gradle"
pluginManagement {
    repositories {
        google()
        mavenCentral()
        maven { url 'https://maven.google.com' }
    }
    def reactNativeGradlePlugin = new File(
        providers.exec {
            workingDir(rootDir)
            commandLine("node", "--print", "require.resolve('@react-native/gradle-plugin/package.json', { paths: [require.resolve('react-native/package.json')] })")
        }.standardOutput.asText.get().trim()
    ).getParentFile().absolutePath
    includeBuild(reactNativeGradlePlugin)

    def expoPluginsPath = new File(
        providers.exec {
            workingDir(rootDir)
            commandLine("node", "--print", "require.resolve('expo-modules-autolinking/package.json', { paths: [require.resolve('expo/package.json')] })")
        }.standardOutput.asText.get().trim(),
        "../android/expo-gradle-plugin"
    ).absolutePath
    includeBuild(expoPluginsPath)
}

plugins {
    id("com.facebook.react.settings")
    id("expo-autolinking-settings")
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_PROJECT)
    repositories {
        google()
        mavenCentral()
        maven { url 'https://maven.google.com' }
        maven { url 'https://www.jitpack.io' }
    }
}

extensions.configure(com.facebook.react.ReactSettingsExtension) { ex ->
    if (System.getenv('EXPO_USE_COMMUNITY_AUTOLINKING') == '1') {
        ex.autolinkLibrariesFromCommand()
    } else {
        ex.autolinkLibrariesFromCommand(expoAutolinking.rnConfigCommand)
    }
}
expoAutolinking.useExpoModules()

rootProject.name = 'Тропа'

expoAutolinking.useExpoVersionCatalog()

include ':app'
includeBuild(expoAutolinking.reactNativeGradlePlugin)
EOF

cat << 'EOF' >> "$PROJ/android/gradle.properties"

# HTTP Proxy configuration
systemProp.http.proxyHost=127.0.0.1
systemProp.http.proxyPort=18080
systemProp.https.proxyHost=127.0.0.1
systemProp.https.proxyPort=18080
EOF

echo -e "\n=== 6. Сборка APK (через прокси) ==="
cd "$PROJ/android"
./gradlew assembleRelease --no-daemon \
  "-Dorg.gradle.jvmargs=-Xmx3g -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=18080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=18080" \
  "-Dorg.gradle.workers.max=2" -PreactNativeArchitectures=arm64-v8a

APK_PATH=$(find "$PROJ/android/app/build/outputs/apk/release" -name "*.apk" | head -1)
DESKTOP_DIR="$HOME/Desktop"
if [ ! -d "$DESKTOP_DIR" ]; then
    DESKTOP_DIR="$HOME/Рабочий стол"
fi
mkdir -p "$DESKTOP_DIR"
cp "$APK_PATH" "$DESKTOP_DIR/Tropa.apk"

echo -e "\n=== ГОТОВО! ==="
echo "APK успешно собран и скопирован на рабочий стол: $DESKTOP_DIR/Tropa.apk"
