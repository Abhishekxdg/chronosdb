// Vectors in the page: telling one apart from other values, folding it into a strip of bars,
// and projecting many of them to 2D for the map (PCA by power iteration: no library, and fast
// enough for the 1,500 vectors the map shows).

/** A vector: a pgvector value or a JSON array of at least 2 numbers. */
export const isVector = (v: unknown): v is number[] => Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && v.every((x) => typeof x === 'number');

/** The vector folded into `bins` averages (or fewer, for short vectors). */
export function fold(v: number[], bins = 32): number[] {
  const n = Math.min(bins, v.length);
  const sum = new Array(n).fill(0);
  const count = new Array(n).fill(0);
  for (let i = 0; i < v.length; i++) {
    const b = Math.floor((i * n) / v.length);
    sum[b] += v[i];
    count[b]++;
  }
  return sum.map((s, i) => s / count[i]);
}

export const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

/** The fields of `row` that hold vectors. */
export const vectorFields = (row: Record<string, unknown> | undefined) => (row ? Object.keys(row).filter((k) => isVector(row[k])) : []);

/** Each vector's position on the data's two main axes (principal components), scaled to [0, 1]. */
export function project(vs: number[][]): [number, number][] {
  const n = vs.length;
  if (!n) return [];
  const d = vs[0].length;
  const mean = new Float64Array(d);
  for (const v of vs) for (let j = 0; j < d; j++) mean[j] += v[j] / n;
  const X = vs.map((v) => Float64Array.from(v, (x, j) => x - mean[j]));
  const axis = (skip: Float64Array | null) => {
    let a = Float64Array.from({ length: d }, (_, j) => Math.sin(j * 12.9898 + (skip ? 3 : 1)));
    for (let it = 0; it < 60; it++) {
      // a <- Xᵀ X a, kept orthogonal to the first axis
      const next = new Float64Array(d);
      for (const x of X) {
        let dot = 0;
        for (let j = 0; j < d; j++) dot += x[j] * a[j];
        for (let j = 0; j < d; j++) next[j] += dot * x[j];
      }
      if (skip) {
        let p = 0;
        for (let j = 0; j < d; j++) p += next[j] * skip[j];
        for (let j = 0; j < d; j++) next[j] -= p * skip[j];
      }
      let len = 0;
      for (let j = 0; j < d; j++) len += next[j] * next[j];
      len = Math.sqrt(len) || 1;
      // stop once the axis stops turning (usually well under 20 rounds)
      let moved = 0;
      for (let j = 0; j < d; j++) moved += Math.abs(next[j] / len - a[j]);
      a = next.map((x) => x / len);
      if (moved < 1e-6 * d) break;
    }
    return a;
  };
  const a1 = axis(null);
  const a2 = axis(a1);
  const pts = X.map((x) => {
    let p = 0;
    let q = 0;
    for (let j = 0; j < d; j++) ((p += x[j] * a1[j]), (q += x[j] * a2[j]));
    return [p, q] as [number, number];
  });
  // one scale for both axes, so distances on the map keep their proportions
  const [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  const [y0, y1] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const [ox, oy] = [(span - (x1 - x0)) / 2, (span - (y1 - y0)) / 2];
  return pts.map(([p, q]) => [(p - x0 + ox) / span, (q - y0 + oy) / span]);
}
