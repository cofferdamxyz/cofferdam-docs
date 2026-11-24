import { McpServer, localhostAllowedHostnames, localhostAllowedOrigins } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import { getCorpus, type Fetch } from "./corpus.ts";
import { search } from "./search.ts";

/**
 * The Cofferdam docs MCP server: Streamable HTTP at
 * `/mcp`, stateless, no authentication. Two read-only tools, `search` and
 * `fetch`, over the pages the site publishes for agents (`corpus.ts`). It has
 * no access to accounts, the API or any store, and it keeps nothing of a
 * request. Callers are rate limited per address.
 *
 * The tool names and result shapes are the ones ChatGPT requires of a search
 * connector (a `search` taking `query`, a `fetch` taking `id`), which other
 * clients accept as ordinary tools.
 *
 * Protocol: the library's, not ours: Cloudflare's `createMcpHandler` over the
 * MCP SDK's `McpServer`, as Cloudflare's own docs server is built. A fresh server answers each
 * request. Revision 2026-07-28 is served natively (`server/discover`, the
 * per-request envelope) and answered as JSON, since these tools send
 * nothing before their result and subscriptions are refused; clients of the
 * earlier
 * revisions are served without a session, as an event stream, and must name
 * both JSON and `text/event-stream` in `Accept`, which is the transport's
 * rule. GET and DELETE answer 405.
 */

export const SERVER_INFO = { name: "cofferdam-docs", title: "Cofferdam Docs", version: "0.2.0" };

const INSTRUCTIONS = [
  "Search and read Cofferdam's developer documentation: the SDK (@cofferdam/sdk, pre-release) and the API.",
  "Call `search` with a few words, then `fetch` the page you need by its id for the full Markdown.",
  "The SDK changes: prefer what these pages say over what you remember, and say so when they do not cover a question.",
  "This server only reads public documentation. It cannot see or change any Cofferdam account.",
].join(" ");

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_CHARS = 500;
const MAX_ID_CHARS = 500;

export interface McpOptions {
  /** The site the corpus is read from, no trailing slash: `https://cofferdam.xyz`. */
  origin: string;
  fetcher: Fetch;
  /**
   * Whether this caller is over its rate limit. Asked once per POST, before
   * the body is read. The Worker counts per client address (`index.ts`).
   */
  overLimit?: () => Promise<boolean>;
  /**
   * The hostnames this server answers on, beside localhost: its `Host` must
   * be one of them, and a browser's `Origin` one of them or the site's. The
   * library allows only localhost and `workers.dev` unless told.
   */
  hostnames?: string[];
}

type Value = Record<string, unknown>;

/** A tool result: the value as structured content, and the same value as JSON text for clients that read only text. */
function result<T extends Value>(value: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

/** A failure the model can read and carry on from, never a protocol error. */
function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function unreadable(error: unknown) {
  return failure(`The Cofferdam docs could not be read: ${error instanceof Error ? error.message : String(error)}`);
}

/** `/docs/x`, `/docs/x/`, `/docs/x.md` or the same on the site's origin, as a page id. */
export function pageId(input: string, origin: string): string {
  let id = input.trim();
  if (id.startsWith(origin)) id = id.slice(origin.length);
  id = id.replace(/[?#].*$/, "").replace(/\.md$/, "").replace(/\/+$/, "");
  return id.startsWith("/") ? id : `/${id}`;
}

/** A server for one request: the library asks for a new one each time. */
export function createDocsServer(options: Pick<McpOptions, "origin" | "fetcher">): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool(
    "search",
    {
      title: "Search Cofferdam docs",
      description:
        "Search Cofferdam's developer documentation and engineering blog. Returns the best-matching section of each page, with the page id to pass to `fetch`.",
      inputSchema: z.strictObject({
        query: z.string().trim().min(1).max(MAX_QUERY_CHARS).describe("A few words: an SDK export, an API route, an error code, a task."),
      }),
      outputSchema: z.object({
        results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), text: z.string() })),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      try {
        const corpus = await getCorpus(options.origin, options.fetcher);
        return result({ results: search(corpus, query) });
      } catch (error) {
        return unreadable(error);
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Read a Cofferdam docs page",
      description: "Read one page of Cofferdam's documentation as Markdown, by the id a `search` result gave (for example `/docs/sdk/quickstart`).",
      inputSchema: z.strictObject({
        id: z.string().trim().min(1).max(MAX_ID_CHARS).describe("The page id from `search`, or a page's address on cofferdam.xyz."),
      }),
      outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        text: z.string(),
        url: z.string(),
        metadata: z.object({ description: z.string(), markdownUrl: z.string() }).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id: input }) => {
      try {
        const corpus = await getCorpus(options.origin, options.fetcher);
        const id = pageId(input, options.origin);
        const doc = corpus.docs.find((candidate) => candidate.id === id);
        if (!doc) return failure(`No documentation page has the id ${id}. Call search to find one.`);
        return result({ id: doc.id, title: doc.title, text: doc.text, url: doc.url, metadata: { description: doc.description, markdownUrl: doc.markdownUrl } });
      } catch (error) {
        return unreadable(error);
      }
    },
  );

  return server;
}

/** The request body as text, or null once it passes the cap; it stops reading there. */
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** The method a request names, in its `Mcp-Method` header or its body; undefined when it is not a readable message. */
function methodOf(request: Request, body: string): string | undefined {
  const header = request.headers.get("mcp-method");
  if (header) return header.trim();
  try {
    const message = JSON.parse(body) as { method?: unknown };
    return typeof message?.method === "string" ? message.method : undefined;
  } catch {
    return undefined;
  }
}

/** Our own refusals, in the shape of the library's: a JSON-RPC error with open CORS. */
function refusal(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status, headers: { "access-control-allow-origin": "*", ...headers } });
}

function hostnameOf(origin: string): string[] {
  try {
    return [new URL(origin).hostname];
  } catch {
    return [];
  }
}

/**
 * Answers one HTTP request to the MCP endpoint. Four things are ours and
 * come before the library sees a POST: the rate limit, the cap on the body,
 * and the refusal of batches and of subscriptions, which would each let one
 * counted request cost many. Everything else (the path, CORS and its preflight, the `Host` and
 * `Origin` checks, both protocol generations) is the library's.
 *
 * A browser may call from the server's own hostnames, the site's and
 * localhost; a client that sends no `Origin`, which is every MCP client that
 * is not a web page, is not restricted. The server has no credentials and
 * only public text, so the check is the library's hygiene, not a secret's
 * guard.
 */
export async function handleMcp(request: Request, options: McpOptions): Promise<Response> {
  const hostnames = options.hostnames ?? [];
  const handler = createMcpHandler(() => createDocsServer(options), {
    route: "/mcp",
    allowedHostnames: [...hostnames, ...localhostAllowedHostnames()],
    allowedOriginHostnames: [...hostnames, ...hostnameOf(options.origin), ...localhostAllowedOrigins()],
  });

  if (request.method !== "POST") return handler.fetch(request);

  if (options.overLimit && (await options.overLimit())) {
    return refusal(429, -32029, "rate limited: try again in a minute", { "retry-after": "60" });
  }
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return refusal(413, -32600, "request too large");
  const body = await readBody(request);
  if (body === null) return refusal(413, -32600, "request too large");

  // One request is one message: the rate limit counts requests, and the
  // library would run a batch of up to a hundred calls for one count.
  // Batches left the protocol in revision 2025-06-18.
  if (body.trimStart().startsWith("[")) return refusal(400, -32600, "batches are not accepted: send one message per request");
  // Nothing here ever changes, so there is nothing to subscribe to, and a
  // listen request would hold a stream open for as long as the caller liked.
  if (methodOf(request, body) === "subscriptions/listen") return refusal(400, -32601, "this server has no subscriptions");

  return handler.fetch(new Request(request.url, { method: "POST", headers: request.headers, body, signal: request.signal }));
}
