# Данные областей для «Тропы» (этап 2)

Пользователь скачивает область один раз и дальше без интернета и VPN получает:
- **карту** — `map.pmtiles` (вырезка из сборки Protomaps);
- **маршруты с подсказками и знаками скорости** — `valhalla.tar`, по ним считает встроенный
  Valhalla (`modules/valhalla-router`);
- **поиск адресов**, включая номера домов, — `search.json`.

Файлы лежат на **сервере данных в России** (Yandex Object Storage, Selectel S3, VK Cloud или
свой nginx — подойдёт любой, кто отдаёт файлы по HTTP с Range). Приложение читает оттуда
`manifest.json`.

## Самый простой путь: GitHub (без своего сервера, бесплатно)

1. Залейте проект в репозиторий на GitHub (публичный: для публичных Actions бесплатны).
2. Вкладка **Actions** → «Данные областей» → **Run workflow**. Можно указать id через пробел,
   например `crimea`; пусто — все из `regions.txt`. Сборка идёт на серверах GitHub (там обычный
   интернет), примерно 20–60 минут на область, и сама выкладывает файлы в релиз `data`.
3. В конце в отчёте будет адрес вида
   `https://github.com/<владелец>/<репозиторий>/releases/download/data/`.
   Создайте `.env` (образец — `.env.example`) со строкой `EXPO_PUBLIC_TROPA_DATA_URL=<адрес>` и
   пересоберите APK. Или введите адрес в телефоне: Настройки → Области без интернета.
4. Дальше данные обновляются сами раз в месяц.

GitHub из России обычно открывается без VPN. Если у кого-то не откроется — можно продублировать
файлы в Yandex Object Storage (раздел 3) и дать этот адрес.

Новая область — строка в `regions.txt`: id, название, рамка (bboxfinder.com) и путь на Geofabrik.

## Вручную на своём компьютере / VPS

### 1. Подготовка (один раз)

| Что | Как |
|---|---|
| docker | https://docs.docker.com/engine/install/ |
| osmium-tool | `sudo apt install osmium-tool` |
| pmtiles | бинарник с https://github.com/protomaps/go-pmtiles/releases, положить в PATH |
| node 22+ | уже есть для проекта |
| OSM России | `wget -P tools/region/src https://download.geofabrik.de/russia-latest.osm.pbf` (~3,5 ГБ) |

Geofabrik, Protomaps и ghcr.io — зарубежные серверы. Удобнее собирать на VPS за границей
(4 ядра, 16 ГБ памяти, 100 ГБ диска) или с VPN. Это делает только разработчик, и только
при обновлении данных. Пользователи потом качают готовые файлы из России.

### 2. Сборка

Одна область:

```bash
bash tools/region/build-region.sh crimea "Крым и Севастополь" 32.40,44.35,36.70,46.25
```

Все области из `regions.txt` и `manifest.json`:

```bash
bash tools/region/build-all.sh
```

Копия базы вышек (по желанию — тогда и вышки качаются из России):

```bash
curl -L -o tools/region/out/cellid.pmtiles https://data.source.coop/smartmaps/opencellid/cellid.pmtiles
node tools/build-manifest.ts tools/region/out
```

Переменные: `OSM_PBF=…`, `MAXZOOM=14` (карта меньше), `SKIP_MAP=1` / `SKIP_ROADS=1` /
`SKIP_SEARCH=1`, `PROTOMAPS_BUILD=https://build.protomaps.com/20261020.pmtiles`.

Примерные размеры: Крым — карта ~150 МБ, дороги ~100 МБ, поиск ~10 МБ; Москва с областью —
в 3–4 раза больше. Если карта выходит большой — `MAXZOOM=14`: на 15+ MapLibre сама увеличит.

**Версия Valhalla.** Тайлы собираются образом `ghcr.io/valhalla/valhalla:3.9.1` — это версия,
вшитая в valhalla-mobile 0.6.4. Если обновите библиотеку (`valhallaMobileVersion` в
`android/gradle.properties`), обновите и `VALHALLA_IMAGE`.

### 3. Загрузка в Yandex Object Storage

```bash
BUCKET=tropa-data bash tools/region/upload-yandex.sh
```

Подробности — в комментариях `upload-yandex.sh`. Адрес для приложения:
`https://storage.yandexcloud.net/tropa-data/`. Его можно:
- вписать в `DEFAULT_DATA_URL` в `src/regions.ts` — тогда у всех пользователей заработает без настройки;
- или ввести в телефоне: Настройки → Области без интернета → Сервер данных.

### 4. Обновление

Пересоберите нужные области и снова запустите `upload-yandex.sh`. В `manifest.json` поменяется
`version` — в приложении рядом с областью появится кнопка обновления.
