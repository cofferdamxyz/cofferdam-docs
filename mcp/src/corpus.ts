/**
 * The corpus the docs MCP answers from: exactly what the site publishes for
 * agents. It reads `llms.txt` for the list of pages and each page's `.md`
 * file for its text, over HTTP from the public site, and keeps the result in
 * memory for a few minutes. Nothing else is read, so the server cannot
 * answer with anything a visitor could not already fetch.
 */

export interface Doc {
  /** The page's path on the site, without `.md`: `/docs/sdk/quickstart`. */
  id: string;
  title: string;
  description: string;
  /** Canonical page address. */
  url: string;
  /** Address of the page's Markdown. */
  markdownUrl: string;
  /** The page as Markdown. */
  text: string;
}

export interface Chunk {
  doc: Doc;
  /** The section heading, or the page title for the text before the first heading. */
  heading: string;
  text: string;
  /** Lower-cased words of the heading and the text, for scoring. */
  words: string[];
}

export interface Corpus {
  docs: Doc[];
  chunks: Chunk[];
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const TTL_MS = 5 * 60_000;
/** How long a failed load is remembered, so a site that is down is not fetched on every call. */
const FAILURE_TTL_MS = 15_000;
const MAX_PAGES = 300;

type Cached = { origin: string; at: number } & ({ corpus: Corpus } | { error: Error });

let cached: Cached | undefined;

/**
 * The corpus for an origin, reused for five minutes. Only a settled result
 * is kept, never the promise of one: a Worker drops a request's fetches when
 * its client goes away, and a promise shared across requests would then
 * never settle and would hang every request after it. Two requests that
 * arrive together each load the corpus; the later result is the one kept.
 */
export async function getCorpus(origin: string, fetcher: Fetch, now = Date.now()): Promise<Corpus> {
  if (cached && cached.origin === origin) {
    if ("corpus" in cached && now - cached.at < TTL_MS) return cached.corpus;
    if ("error" in cached && now - cached.at < FAILURE_TTL_MS) throw cached.error;
  }
  try {
    const corpus = await loadCorpus(origin, fetcher);
    cached = { origin, at: now, corpus };
    return corpus;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    cached = { origin, at: now, error: failure };
    throw failure;
  }
}

export function clearCorpusCache(): void {
  cached = undefined;
}

/** `- [Title](https://…/page.md): description` lines of `llms.txt`, for pages on `origin` only. */
export function parseIndex(index: string, origin: string): Omit<Doc, "text">[] {
  const entries: Omit<Doc, "text">[] = [];
  const seen = new Set<string>();
  for (const match of index.matchAll(/^\s*- \[([^\]]+)\]\(([^)\s]+\.md)\)(?::[ \t]*(.*))?$/gm)) {
    const [, title, markdownUrl, description] = match;
    if (!title || !markdownUrl || !markdownUrl.startsWith(`${origin}/`)) continue;
    const id = markdownUrl.slice(origin.length, -".md".length);
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, title, description: description?.trim() ?? "", url: `${origin}${id}`, markdownUrl });
  }
  return entries;
}

/**
 * One more try for a read that threw or answered a server error: every page
 * is fetched at once and one dropped connection would otherwise fail the
 * whole load. A page that is missing (404) is not retried.
 */
async function fetchOnceMore(fetcher: Fetch, url: string): Promise<Response> {
  try {
    const response = await fetcher(url);
    if (response.status < 500) return response;
  } catch {
    // fall through to the second try
  }
  return fetcher(url);
}

async function loadCorpus(origin: string, fetcher: Fetch): Promise<Corpus> {
  const response = await fetchOnceMore(fetcher, `${origin}/llms.txt`);
  if (!response.ok) throw new Error(`the documentation index answered ${response.status}`);
  const entries = parseIndex(await response.text(), origin).slice(0, MAX_PAGES);
  if (entries.length === 0) throw new Error("the documentation index lists no pages");

  const docs = await Promise.all(
    entries.map(async (entry): Promise<Doc> => {
      const page = await fetchOnceMore(fetcher, entry.markdownUrl);
      if (!page.ok) throw new Error(`${entry.id}.md answered ${page.status}`);
      return { ...entry, text: await page.text() };
    }),
  );
  return { docs, chunks: docs.flatMap(chunksOf) };
}

/** A page split at its `##` headings, so a search result is a section, not a whole page. */
export function chunksOf(doc: Doc): Chunk[] {
  const chunks: Chunk[] = [];
  let heading = doc.title;
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) chunks.push({ doc, heading, text, words: tokenize(`${doc.title} ${heading} ${text}`) });
    lines = [];
  };
  for (const line of doc.text.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const match = fenced ? null : /^##\s+(.+?)(?:\s+\[#[^\]]+\])?\s*$/.exec(line);
    if (match?.[1]) {
      flush();
      heading = match[1];
    } else {
      lines.push(line);
    }
  }
  flush();
  return chunks;
}

/** Lower-cased words; `checkOnChain` also yields `check`, `on`, `chain`, and `csa1:` yields `csa1`. */
export function tokenize(text: string): string[] {
  const words: string[] = [];
  for (const raw of text.match(/[A-Za-z0-9_@/.-]+/g) ?? []) {
    const word = raw.replace(/^[^A-Za-z0-9@]+|[^A-Za-z0-9]+$/g, "");
    if (!word) continue;
    words.push(word.toLowerCase());
    const parts = word.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
    if (parts.length > 1) for (const part of parts) words.push(part.toLowerCase());
  }
  return words;
}
