// Стиль карты: векторные плитки из локального файла .pmtiles + шрифты внутри APK.
// Интернет не нужен ни для плиток, ни для подписей.

import { layers, namedFlavor } from '@protomaps/basemaps';
import type { StyleSpecification } from '@maplibre/maplibre-react-native';

const GLYPHS = 'asset://glyphs/{fontstack}/{range}.pbf';

/** Онлайн-карта OpenFreeMap: бесплатно, без ключа. Просмотренные места кэшируются в телефоне. */
export const ONLINE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * Есть скачанная карта (.pmtiles) — рисуем её, она работает без интернета.
 * Нет — берём онлайн-карту OpenFreeMap (при пропаже интернета остаётся то, что успело закэшироваться).
 */
export function buildStyle(pmtilesUri: string | null): StyleSpecification | string {
  if (!pmtilesUri) return ONLINE_STYLE;
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      protomaps: {
        type: 'vector',
        url: 'pmtiles://' + pmtilesUri, // pmtiles://file:///data/user/0/.../map.pmtiles
        attribution: '© OpenStreetMap · Protomaps',
      },
    },
    layers: layers('protomaps', namedFlavor('light'), { lang: 'ru' }) as StyleSpecification['layers'],
  };
}

// ---------- Онлайн-стиль по-русски ----------
// В стиле OpenFreeMap подписи двуязычные («Sevastopol / Севастополь», «Khrustalyova Street»).
// Скачиваем стиль, меняем все подписи с названиями на русское имя (name:ru, иначе местное name)
// и храним копию в телефоне — чтобы и без интернета стиль был под рукой.

const RU_NAME = ['coalesce', ['get', 'name:ru'], ['get', 'name']];

export function russifyStyle(style: any): any {
  for (const l of style.layers ?? []) {
    const tf = l.layout?.['text-field'];
    if (tf == null) continue;
    const str = JSON.stringify(tf);
    if (/"name(_en|_de|:latin|:nonlatin|:en)?"|\{name/.test(str)) l.layout['text-field'] = RU_NAME;
  }
  return style;
}

/**
 * Стиль карты: сначала сохранённая копия (карта появляется сразу, даже без сети),
 * а свежая версия качается в фоне с таймаутом и пригодится при следующем запуске.
 * Раньше запуск ждал сервер без таймаута — без VPN карта долго была «голой».
 */
export async function loadOnlineStyle(): Promise<StyleSpecification | string> {
  const { Directory, File, Paths } = await import('expo-file-system');
  const { fetchJson } = await import('./net.ts');
  const dir = new Directory(Paths.document, 'tropa');
  const f = new File(dir, 'style-liberty-ru.json');
  const refresh = async () => {
    const st = russifyStyle(await fetchJson(ONLINE_STYLE, { timeoutMs: 8000 }));
    try { if (!dir.exists) dir.create({ intermediates: true }); f.write(JSON.stringify(st)); } catch {}
    return st;
  };
  let cached: any = null;
  try { if (f.exists) cached = JSON.parse(await f.text()); } catch {}
  if (cached) { refresh().catch(() => {}); return cached; }
  try { return await refresh(); } catch {}
  return ONLINE_STYLE;
}

/** Лёгкий режим для слабых телефонов: без 3D-домов, без цветных точек мест и мелких подписей. */
export function liteStyle(base: any): any {
  if (!base || typeof base !== 'object') return base;
  const st = { ...base, layers: (base.layers ?? []).filter((l: any) => {
    if (l.type === 'fill-extrusion') return false;
    if (String(l.id).endsWith('-dot')) return false;
    if (l.type === 'symbol' && l['source-layer'] === 'poi') return false;
    return true;
  }) };
  return st;
}

// ---------- Краски карты: светлая «как в навигаторе» и тёмная ----------
// Берём стиль Liberty (в нём есть 3D-дома и значки мест) и перекрашиваем:
//   дороги — по важности (магистрали оранжевые, главные жёлтые, остальные белые/серые);
//   вода, парки, дома — насыщеннее; ночью — всё в тёмных тонах.
// Значки мест заменяем цветными точками по типу места (еда, магазины, медицина…), как в 2ГИС.

type Pal = Record<string, string>;
const LIGHT_MAP: Pal = {
  bg: '#f4f2ee', land: '#efece6', water: '#9fd0f2', green: '#c8eab8', wood: '#b9dfa8', sand: '#f3e7c4',
  building: '#e3ddd4', building3d: '#e7e1d9', motorway: '#ffad5c', motorwayCase: '#e0882f',
  primary: '#ffd866', primaryCase: '#e0b444', secondary: '#fff3b0', secondaryCase: '#d9c98a',
  minor: '#ffffff', minorCase: '#d6d0c8', path: '#c0b6a8', rail: '#b9b3ab',
  text: '#3c3f45', halo: '#ffffff', waterText: '#3a78b3', boundary: '#b79ab8',
};
const DARK_MAP: Pal = {
  bg: '#141833', land: '#161b38', water: '#1d2f5e', green: '#18302f', wood: '#172d2b', sand: '#2a2742',
  building: '#232a4c', building3d: '#2a3258', motorway: '#c4823f', motorwayCase: '#6e4721',
  primary: '#9c8241', primaryCase: '#54451f', secondary: '#4d525c', secondaryCase: '#2d3139',
  minor: '#323a62', minorCase: '#1a1f3d', path: '#4a5280', rail: '#4a5078',
  text: '#dfe3f5', halo: '#141833', waterText: '#8fb4ff', boundary: '#7a68a0',
};

const POI_COLORS: [string[], string][] = [
  [['restaurant', 'fast_food', 'cafe', 'bar', 'beer', 'ice_cream', 'bakery'], '#f76707'],
  [['shop', 'grocery', 'supermarket', 'clothing_store', 'mall', 'convenience', 'hardware', 'jewelry', 'shoe', 'gift', 'book', 'electronics'], '#7048e8'],
  [['hospital', 'pharmacy', 'doctors', 'dentist', 'clinic', 'veterinary'], '#e03131'],
  [['school', 'college', 'library', 'university', 'kindergarten'], '#a0522d'],
  [['park', 'garden', 'playground', 'zoo', 'picnic_site', 'campsite', 'beach'], '#2f9e44'],
  [['lodging', 'hotel', 'motel', 'hostel'], '#d6336c'],
  [['fuel', 'car', 'car_repair', 'parking', 'charging_station', 'bicycle'], '#1c7ed6'],
  [['bank', 'atm', 'post', 'town_hall', 'police', 'fire_station'], '#0ca678'],
  [['museum', 'attraction', 'theatre', 'cinema', 'art_gallery', 'monument', 'castle', 'viewpoint'], '#ae3ec9'],
  [['place_of_worship'], '#e67700'],
];

function poiColorExpr(): any {
  const m: any[] = ['match', ['get', 'class']];
  for (const [classes, color] of POI_COLORS) m.push(classes, color);
  m.push('#868e96');
  return m;
}

const setPaint = (l: any, k: string, v: any) => { l.paint = l.paint ?? {}; l.paint[k] = v; };

export function skinStyle(base: any, dark: boolean): any {
  const st = JSON.parse(JSON.stringify(base));
  const P = dark ? DARK_MAP : LIGHT_MAP;
  const out: any[] = [];
  for (const l of st.layers ?? []) {
    const id: string = l.id ?? '';
    const sl: string = l['source-layer'] ?? '';
    if (l.type === 'background') setPaint(l, 'background-color', P.bg);
    else if (l.type === 'raster') { setPaint(l, 'raster-opacity', dark ? 0.15 : 0.6); }
    else if (l.type === 'fill') {
      if (sl === 'water' || /water/.test(id)) setPaint(l, 'fill-color', P.water);
      else if (/wood|forest/.test(id)) setPaint(l, 'fill-color', P.wood);
      else if (/park|grass|meadow|scrub|landcover|garden|cemetery|pitch/.test(id)) setPaint(l, 'fill-color', P.green);
      else if (/sand|beach/.test(id)) setPaint(l, 'fill-color', P.sand);
      else if (sl === 'building' || /^building/.test(id)) { setPaint(l, 'fill-color', P.building); setPaint(l, 'fill-outline-color', dark ? '#1c2129' : '#d6cfc4'); }
      else if (/residential|landuse/.test(id)) setPaint(l, 'fill-color', P.land);
    } else if (l.type === 'fill-extrusion') {
      setPaint(l, 'fill-extrusion-color', P.building3d);
      setPaint(l, 'fill-extrusion-opacity', dark ? 0.9 : 0.8);
    } else if (l.type === 'line') {
      const casing = /casing|outline/.test(id);
      if (/waterway|river|stream/.test(id) || sl === 'waterway') setPaint(l, 'line-color', P.water);
      else if (/rail|transit/.test(id)) setPaint(l, 'line-color', P.rail);
      else if (/boundary|admin/.test(id)) setPaint(l, 'line-color', P.boundary);
      else if (sl === 'transportation' || /road|highway|bridge|tunnel/.test(id)) {
        let c: string | null = null;
        if (/motorway/.test(id)) c = casing ? P.motorwayCase : P.motorway;
        else if (/trunk|primary/.test(id)) c = casing ? P.primaryCase : P.primary;
        else if (/secondary|tertiary/.test(id)) c = casing ? P.secondaryCase : P.secondary;
        else if (/path|pedestrian|footway|steps|track|cycle/.test(id)) c = P.path;
        else if (/minor|service|street|link|residential|road/.test(id)) c = casing ? P.minorCase : P.minor;
        if (c) setPaint(l, 'line-color', c);
      }
    } else if (l.type === 'symbol') {
      if (l.layout?.['text-field'] != null) {
        setPaint(l, 'text-color', /water/.test(id) ? P.waterText : P.text);
        setPaint(l, 'text-halo-color', P.halo);
        setPaint(l, 'text-halo-width', 1.4);
      }
      // Значки мест — цветная круглая подложка + иконка + подпись снизу
      if (sl === 'poi' && !/transit|bus|railway|station/.test(id)) {
        out.push({
          id: `${id}-dot`, type: 'circle', source: l.source, 'source-layer': sl,
          ...(l.filter ? { filter: l.filter } : {}), ...(l.minzoom != null ? { minzoom: l.minzoom } : {}), ...(l.maxzoom != null ? { maxzoom: l.maxzoom } : {}),
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 6, 17, 10],
            'circle-color': poiColorExpr(),
            'circle-stroke-color': dark ? '#141833' : '#ffffff',
            'circle-stroke-width': 1.5,
          },
        });
        if (l.layout) {
          // Сохраняем иконку из стиля OpenFreeMap (полиция, спорт, кафе, магазин и т.д.)
          l.layout['icon-anchor'] = 'center';
          l.layout['icon-size'] = ['interpolate', ['linear'], ['zoom'], 14, 0.65, 17, 0.9];
          l.layout['text-anchor'] = 'top';
          l.layout['text-justify'] = 'center';
          l.layout['text-offset'] = [0, 0.9];
          l.layout['text-size'] = 11;
        }
        setPaint(l, 'text-color', dark ? '#dfe3f5' : '#212529');
      }
    }
    out.push(l);
  }
  st.layers = out;
  return st;
}

/** Стиль для протомапс-карты из файла: просто тёмная/светлая палитра Protomaps. */
export function fileStyle(pmtilesUri: string, dark: boolean): StyleSpecification {
  const base = buildStyle(pmtilesUri) as any;
  base.layers = layers('protomaps', namedFlavor(dark ? 'dark' : 'light'), { lang: 'ru' });
  return base;
}
