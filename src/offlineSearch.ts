// Поиск адресов без интернета — по индексу названий скачанной области.
//
// Индекс готовится на компьютере (tools/build-search-index.ts) из тех же данных OSM.
// Формат (search.json):
//   {
//     v: 1,
//     items:  [[название, подробности, lat, lon, osmKey, osmValue], …]  — места, улицы, города;
//     cities: ["Севастополь", …],                                         — для подписей домов;
//     houses: { "улица Ленина": [["5Б", lat, lon, индекс города], …], … } — дома по улицам.
//   }
// Дома лежат отдельно и сгруппированы по улице: их много (в большой области — сотни тысяч),
// а ищем мы их только когда в запросе есть номер — так на старом телефоне не тратится память.
// Здесь только чистые функции — без expo, чтобы работали и в тестах.

import type { RawPlace } from './searchRank.ts';

export type SearchIndex = {
  v: 1;
  items: [string, string, number, number, string, string][];
  cities?: string[];
  houses?: Record<string, [string, number, number, number][]>;
};

type Prepared = {
  items: SearchIndex['items'];
  words: string[][];
  nameLen: number[];
  cities: string[];
  streets: { name: string; words: string[] }[];
  houses: Record<string, [string, number, number, number][]>;
};

/** «Ул. Ленина, 5Б» → «ул ленина 5б»: нижний регистр, ё→е, без знаков. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Служебные слова не мешают поиску: «улица Ленина» найдёт «Ленина улица» и «ул. Ленина»
const STOP = new Set(['улица', 'ул', 'проспект', 'пр', 'просп', 'переулок', 'пер', 'площадь', 'пл', 'бульвар', 'бул', 'шоссе', 'ш', 'проезд', 'пр-д', 'набережная', 'наб', 'дом', 'д', 'город', 'г', 'посёлок', 'поселок', 'пос', 'село', 'с', 'корпус', 'корп', 'к', 'строение', 'стр']);

export function prepare(index: SearchIndex): Prepared {
  const houses = index.houses ?? {};
  return {
    items: index.items,
    words: index.items.map((it) => norm(`${it[0]} ${it[1]}`).split(' ')),
    nameLen: index.items.map((it) => norm(it[0]).split(' ').length),
    cities: index.cities ?? [],
    streets: Object.keys(houses).map((name) => ({ name, words: norm(name).split(' ') })),
    houses,
  };
}

/** Все слова запроса — начала каких-то слов из списка? Возвращает очки или 0. */
function matchWords(qw: string[], words: string[], nameLen = words.length): number {
  let score = 0;
  for (const w of qw) {
    let best = 0;
    for (let k = 0; k < words.length; k++) {
      const word = words[k];
      if (!word.startsWith(w)) continue;
      const s = (word === w ? 3 : 2) + (k < nameLen ? 2 : 0);
      if (s > best) best = s;
    }
    if (!best) return 0;
    score += best;
  }
  return score;
}

/**
 * Каждое слово запроса должно быть началом какого-то слова названия/адреса.
 * Совпадение в названии весит больше, чем в подробностях; точное слово — больше начала.
 * Если в запросе есть номер дома («Ленина 5», «ленина, 5б») — ищем ещё и дома.
 */
export function searchIndex(p: Prepared, q: string, limit = 40): RawPlace[] {
  const all = norm(q).split(' ').filter((w) => w && !STOP.has(w));
  if (!all.length) return [];
  const nums = all.filter((w) => /^\d/.test(w));
  const words = all.filter((w) => !/^\d/.test(w));
  const scored: { place: RawPlace; score: number }[] = [];

  // дома: «улица + номер»
  if (nums.length && words.length && p.streets.length) {
    const num = nums[0];
    for (const st of p.streets) {
      const ss = matchWords(words, st.words);
      if (!ss) continue;
      for (const [hn, lat, lon, ci] of p.houses[st.name]) {
        const h = norm(hn).replace(/ /g, '');
        if (!h.startsWith(num)) continue;
        const exact = h === num || h === num + (nums[1] ?? '');
        scored.push({
          score: ss + (exact ? 6 : 4),
          place: { name: `${st.name}, ${hn}`, detail: p.cities[ci] ?? '', lat, lon, osmKey: 'place', osmValue: 'house', layer: 'house', fromLocal: true, order: 0 },
        });
      }
    }
  }

  // места, улицы, города — по всем словам запроса (номер тоже может быть в названии: «Школа 5»)
  for (let i = 0; i < p.items.length; i++) {
    const sc = matchWords(all, p.words[i], p.nameLen[i]) || (nums.length && words.length ? matchWords(words, p.words[i], p.nameLen[i]) * 0.5 : 0);
    if (!sc) continue;
    const [name, detail, lat, lon, osmKey, osmValue] = p.items[i];
    scored.push({ score: sc, place: { name, detail, lat, lon, osmKey, osmValue, fromLocal: true, order: 0 } });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ place }, order) => ({ ...place, order }));
}
