import { tokenize, type Chunk, type Corpus } from "./corpus.ts";

export interface SearchHit {
  /** The page's id, to pass to `fetch`. */
  id: string;
  /** "Page title: Section". */
  title: string;
  url: string;
  /** The matching section's text, cut to a readable length. */
  text: string;
}

const K1 = 1.2;
const B = 0.75;
const SNIPPET_CHARS = 1200;

/**
 * Ranks the corpus's sections against a query with BM25 and returns the best
 * section of each page, best first. The corpus is small (tens of pages), so
 * this runs over it in memory on every call and needs no index or store.
 */
export function search(corpus: Corpus, query: string, limit = 6): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || corpus.chunks.length === 0) return [];

  const total = corpus.chunks.length;
  const averageLength = corpus.chunks.reduce((sum, chunk) => sum + chunk.words.length, 0) / total;
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(term, corpus.chunks.filter((chunk) => chunk.words.includes(term)).length);
  }

  const scored: { chunk: Chunk; score: number }[] = [];
  for (const chunk of corpus.chunks) {
    let score = 0;
    for (const term of terms) {
      const frequency = chunk.words.filter((word) => word === term).length;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += (idf * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * chunk.words.length) / averageLength));
    }
    if (score > 0) scored.push({ chunk, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const hits: SearchHit[] = [];
  const pages = new Set<string>();
  for (const { chunk } of scored) {
    if (pages.has(chunk.doc.id)) continue;
    pages.add(chunk.doc.id);
    hits.push({
      id: chunk.doc.id,
      title: chunk.heading === chunk.doc.title ? chunk.doc.title : `${chunk.doc.title}: ${chunk.heading}`,
      url: chunk.doc.url,
      text: chunk.text.length > SNIPPET_CHARS ? `${chunk.text.slice(0, SNIPPET_CHARS)}…` : chunk.text,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
