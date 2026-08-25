// Мини-библиотека плотных матриц для фильтра Калмана (размеры 6x6 и меньше).
// Своя, чтобы ядро не тянуло зависимостей и одинаково работало в Node и в Hermes.

export type Mat = number[][];

export function zeros(r: number, c: number): Mat {
  return Array.from({ length: r }, () => new Array<number>(c).fill(0));
}

export function eye(n: number): Mat {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

export function mul(a: Mat, b: Mat): Mat {
  const r = a.length, n = b.length, c = b[0].length;
  const out = zeros(r, c);
  for (let i = 0; i < r; i++)
    for (let k = 0; k < n; k++) {
      const aik = a[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < c; j++) out[i][j] += aik * b[k][j];
    }
  return out;
}

export function transpose(a: Mat): Mat {
  const out = zeros(a[0].length, a.length);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a[0].length; j++) out[j][i] = a[i][j];
  return out;
}

export function add(a: Mat, b: Mat): Mat {
  return a.map((row, i) => row.map((v, j) => v + b[i][j]));
}

export function sub(a: Mat, b: Mat): Mat {
  return a.map((row, i) => row.map((v, j) => v - b[i][j]));
}

/** Обращение матрицы до 3x3 (размер измерения у нас 1 или 2). */
export function invSmall(a: Mat): Mat {
  const n = a.length;
  if (n === 1) return [[1 / a[0][0]]];
  if (n === 2) {
    const det = a[0][0] * a[1][1] - a[0][1] * a[1][0];
    return [
      [a[1][1] / det, -a[0][1] / det],
      [-a[1][0] / det, a[0][0] / det],
    ];
  }
  throw new Error('invSmall: поддерживаются только 1x1 и 2x2');
}

/** Симметризация, чтобы ковариация не «расползалась» из-за округлений. */
export function symmetrize(p: Mat): Mat {
  const n = p.length;
  const out = zeros(n, n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i][j] = 0.5 * (p[i][j] + p[j][i]);
  return out;
}
