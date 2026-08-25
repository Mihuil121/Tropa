# Сборка APK «Тропы» прямо на своём компьютере с Windows — без облака.
#
# Запуск: PowerShell ОТ АДМИНИСТРАТОРА, из папки проекта:
#     Set-ExecutionPolicy -Scope Process Bypass -Force; .\build-local.ps1
#
# Что нужно: Windows 10, ~15 ГБ свободного места на C:, интернет (скачается ~3–4 ГБ).
# Первый раз идёт долго: 40–90 минут на старом ноутбуке. Следующие сборки — 5–15 минут.
# Важно: запускайте в своём окне PowerShell, а не через ИИ-помощника в редакторе —
# у помощника «песочница», и серверы Google для Android ему закрыты (поэтому у него не вышло).

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$ProgressPreference = 'SilentlyContinue'   # без этого скачивание в старом PowerShell очень медленное

$Tools = 'C:\tropa-build'
$Proj  = $PSScriptRoot
New-Item -ItemType Directory -Force $Tools | Out-Null

function Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

# --- 0. Короткий путь к проекту: у Android-сборки на Windows лимит длины путей ---
Step 'Длинные пути в Windows'
New-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWord -Force | Out-Null
if ($Proj.Length -gt 20) {
  Write-Host "Папка проекта: $Proj" -ForegroundColor Yellow
  Write-Host 'Путь длинный. Если сборка упадёт с ошибкой про длину пути — перенесите проект в C:\tropa и запустите снова.' -ForegroundColor Yellow
}

# --- 1. Node.js ---
Step 'Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js не установлен. Установите его с nodejs.org (версия 22 LTS, установщик .msi), перезапустите PowerShell и запустите скрипт снова.'
}
node -v

# --- 2. Java 17 ---
Step 'Java 17'
$Jdk = Get-ChildItem $Tools -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Jdk) {
  Write-Host 'Скачиваю Java 17 (Temurin, ~190 МБ)...'
  Invoke-WebRequest 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse' -OutFile "$Tools\jdk.zip" -UseBasicParsing
  Expand-Archive "$Tools\jdk.zip" $Tools -Force
  Remove-Item "$Tools\jdk.zip"
  $Jdk = Get-ChildItem $Tools -Directory -Filter 'jdk-21*' | Select-Object -First 1
}
$env:JAVA_HOME = $Jdk.FullName
$env:Path = "$($Jdk.FullName)\bin;$env:Path"
java -version

# --- 3. Android SDK (только инструменты; остальное Gradle докачает сам) ---
Step 'Android SDK'
$Sdk = "$Tools\android-sdk"
$Mgr = "$Sdk\cmdline-tools\latest\bin\sdkmanager.bat"
if (-not (Test-Path $Mgr)) {
  Write-Host 'Скачиваю Android command-line tools (~150 МБ)...'
  Invoke-WebRequest 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' -OutFile "$Tools\clt.zip" -UseBasicParsing
  Expand-Archive "$Tools\clt.zip" "$Tools\clt" -Force
  New-Item -ItemType Directory -Force "$Sdk\cmdline-tools" | Out-Null
  Move-Item "$Tools\clt\cmdline-tools" "$Sdk\cmdline-tools\latest" -Force
  Remove-Item "$Tools\clt.zip", "$Tools\clt" -Recurse -Force
}
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
Write-Host 'Принимаю лицензии Android SDK...'
$yes = ('y' + "`n") * 30
$yes | & $Mgr --sdk_root=$Sdk --licenses | Out-Null
& $Mgr --sdk_root=$Sdk 'platform-tools' | Out-Null

# --- 4. Зависимости проекта ---
Step 'Зависимости проекта (npm)'
Set-Location $Proj
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci не прошёл — пришлите текст ошибки' }

# --- 5. Android-проект ---
Step 'Генерация Android-проекта'
$env:CI = '1'
npx expo prebuild --platform android --no-install
if ($LASTEXITCODE -ne 0) { throw 'expo prebuild не прошёл — пришлите текст ошибки' }
"sdk.dir=$($Sdk -replace '\\','\\')" | Set-Content "$Proj\android\local.properties" -Encoding ASCII

# --- 6. Сборка (бережём память: 8 ГБ на ноутбуке) ---
Step 'Сборка APK (долго — это нормально)'
Set-Location "$Proj\android"
.\gradlew.bat assembleRelease --no-daemon "-Dorg.gradle.jvmargs=-Xmx3g" "-Dorg.gradle.workers.max=2" "-PreactNativeArchitectures=arm64-v8a"
if ($LASTEXITCODE -ne 0) { throw 'Сборка не прошла — пришлите последние 30 строк вывода' }

$Apk = Get-ChildItem "$Proj\android\app\build\outputs\apk\release\*.apk" | Select-Object -First 1
$Out = "$env:USERPROFILE\Desktop\Tropa.apk"
Copy-Item $Apk.FullName $Out -Force
Write-Host "`nГотово! APK лежит на рабочем столе: $Out" -ForegroundColor Green
Write-Host 'Перекиньте его на телефон и установите.' -ForegroundColor Green
