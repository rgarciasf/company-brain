// Lexical BM25 search over chunks. Runs fully local: no embeddings service needed.
import type { Chunk } from "./ingest.ts";

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i in is it its me my of on or our should that the their them there this to was we what when where which who why will with you your about into than then also any all not no".split(" "),
);

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9$][a-z0-9$.\-/]*[a-z0-9]|[a-z0-9]/g) ?? [])
    .flatMap((t) => (t.includes("-") || t.includes("/") ? [t, ...t.split(/[-/]/)] : [t]))
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
}

export class BM25Index {
  private chunks: Chunk[] = [];
  private tf: Map<string, number>[] = [];
  private len: number[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  constructor(chunks: Chunk[]) {
    this.chunks = chunks;
    for (const c of chunks) {
      // Title and heading are repeated to boost them.
      const tokens = tokenize(`${c.title} ${c.heading} ${c.title} ${c.heading} ${c.text}`);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.tf.push(tf);
      this.len.push(tokens.length);
    }
    this.avgLen = this.len.reduce((a, b) => a + b, 0) / Math.max(1, chunks.length);
  }

  search(query: string, opts: { limit?: number; filter?: (c: Chunk) => boolean } = {}): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const N = this.chunks.length;
    const hits: SearchHit[] = [];
    this.chunks.forEach((chunk, i) => {
      if (opts.filter && !opts.filter(chunk)) return;
      let score = 0;
      for (const t of terms) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.len[i]) / this.avgLen)));
      }
      if (score <= 0) return;
      if (chunk.status === "superseded") score *= 0.8; // prefer current sources
      hits.push({ chunk, score });
    });
    return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8);
  }
}
