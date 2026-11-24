// Finds likely-duplicate issues with TF-IDF cosine similarity over titles (weighted) and body openings.
// Candidate pairs come from an inverted index, so this stays fast on several thousand issues.

const STOP = new Set(
  ('a an the and or but if of to in on for with without at by from into is are was were be been being it its this that these those ' +
    'i im i\'m we you he she they my our your their me us them do does did doing done not no can cant cannot could should would will ' +
    'when while where what which who how why after before then than so such also just only very more most some any all each when ' +
    'use using used get got getting have has had make makes making work works working issue bug error problem feature request ' +
    'support add adding allow please new option ability able want need way possible like via etc e g ie').split(/\s+/),
);

const stem = (w) => w.replace(/(ings|ing|edly|ed|es|s)$/, (m) => (w.length - m.length >= 4 ? '' : m));

export function tokens(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9_.+#-]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.\-#]+|[.\-]+$/g, ''))
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

/**
 * @param {{key:string,title:string,body?:string}[]} docs
 * @returns {{clusters: string[][], pairs: Map<string, {other:string, sim:number}[]>}}
 */
export function findDuplicates(docs, { threshold = 0.62, maxDfRatio = 0.04, maxCluster = 12 } = {}) {
  const N = docs.length;
  if (N < 2) return { clusters: [], pairs: new Map() };
  const tf = docs.map((d) => {
    const m = new Map();
    for (const t of tokens(d.title)) m.set(t, (m.get(t) || 0) + 2);
    for (const t of tokens((d.body || '').slice(0, 500))) m.set(t, (m.get(t) || 0) + 0.5);
    return m;
  });
  const df = new Map();
  for (const m of tf) for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);
  const vecs = tf.map((m) => {
    const v = new Map();
    let norm = 0;
    for (const [t, c] of m) {
      const w = (1 + Math.log(c)) * Math.log(1 + N / df.get(t));
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
  // Inverted index on title tokens only, skipping words common enough to be meaningless here.
  const cap = Math.max(4, Math.floor(N * maxDfRatio));
  const index = new Map();
  docs.forEach((d, i) => {
    for (const t of new Set(tokens(d.title))) {
      if (df.get(t) > cap) continue;
      if (!index.has(t)) index.set(t, []);
      index.get(t).push(i);
    }
  });
  const pairs = new Map();
  const parent = docs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const seen = new Set();
  for (const list of index.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a], j = list[b];
        const id = i < j ? i * N + j : j * N + i;
        if (seen.has(id)) continue;
        seen.add(id);
        const [small, big] = vecs[i].size < vecs[j].size ? [vecs[i], vecs[j]] : [vecs[j], vecs[i]];
        let sim = 0;
        for (const [t, w] of small) { const o = big.get(t); if (o) sim += w * o; }
        if (sim < threshold) continue;
        for (const [x, y] of [[i, j], [j, i]]) {
          const k = docs[x].key;
          if (!pairs.has(k)) pairs.set(k, []);
          pairs.get(k).push({ other: docs[y].key, sim: Math.round(sim * 100) / 100 });
        }
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map();
  docs.forEach((d, i) => {
    if (!pairs.has(d.key)) return;
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(d.key);
  });
  // Chained clusters that grew too big are usually a shared topic, not true duplicates: keep only the tightest members.
  const clusters = [...groups.values()].map((g) => {
    if (g.length <= maxCluster) return g;
    return g
      .map((k) => ({ k, best: Math.max(...pairs.get(k).map((p) => p.sim)) }))
      .sort((a, b) => b.best - a.best)
      .slice(0, maxCluster)
      .map((x) => x.k);
  });
  for (const list of pairs.values()) list.sort((a, b) => b.sim - a.sim);
  return { clusters: clusters.filter((c) => c.length > 1), pairs };
}
