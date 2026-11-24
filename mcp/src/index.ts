import { handleMcp } from "./mcp.ts";

/**
 * The Worker: `POST /mcp` is the docs MCP server; every other path sends a
 * browser to the page that explains it. One binding, the rate limit; no
 * store, no secrets, no logs (`wrangler.jsonc`). The protocol is the
 * library's (`mcp.ts`).
 */
interface Env {
  /** The published site: the origin in every address the server hands out. */
  DOCS_ORIGIN?: string;
  /**
   * Where the same paths are fetched from, when that is not `DOCS_ORIGIN`:
   * a local export or a preview deployment, to try the server against pages
   * that are not live yet. Unset in production.
   */
  DOCS_FETCH_ORIGIN?: string;
  /**
   * The per-address rate limit, a Workers Rate Limiting binding. It counts
   * requests and holds nothing else. Unbound,
   * as in tests, nothing is limited.
   */
  DOCS_MCP_RL?: RateLimit;
  /**
   * The hostnames the server answers on, comma separated, beside localhost.
   * The library refuses a `Host` or a browser `Origin` it was not told of.
   */
  MCP_HOSTNAMES?: string;
}

/** The part of a Workers Rate Limiting binding this Worker uses. */
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const DEFAULT_ORIGIN = "https://cofferdam.xyz";
const DEFAULT_HOSTNAMES = "docs.cofferdam.xyz";

/**
 * Whether the request's address is over the limit. Cloudflare's edge sets
 * the address on every request; one that arrives without it (local
 * development) is counted with the others like it, never left uncounted. A
 * limiter that fails does not take the docs down with it: the server only
 * reads public pages.
 */
/**
 * What a caller is counted under: an IPv4 address whole, an IPv6 address by
 * its first four groups, since one subscriber is usually given all the
 * addresses that share them and could otherwise never reach the limit.
 */
export function limitKey(address: string | null): string {
  if (!address) return "no-address";
  if (!address.includes(":")) return address;
  const [head = "", tail] = address.toLowerCase().split("::");
  const front = head.split(":").filter(Boolean);
  const back = tail === undefined ? [] : tail.split(":").filter(Boolean);
  const groups = tail === undefined ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

async function overLimit(request: Request, limiter: RateLimit | undefined): Promise<boolean> {
  if (!limiter) return false;
  try {
    return !(await limiter.limit({ key: limitKey(request.headers.get("cf-connecting-ip")) })).success;
  } catch {
    return false;
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = (env.DOCS_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
    const fetchOrigin = (env.DOCS_FETCH_ORIGIN ?? origin).replace(/\/+$/, "");
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp") {
      return handleMcp(request, {
        origin,
        // The corpus loader only ever asks for addresses under `origin`.
        fetcher: (input, init) => fetch(fetchOrigin + input.slice(origin.length), init),
        overLimit: () => overLimit(request, env.DOCS_MCP_RL),
        hostnames: (env.MCP_HOSTNAMES ?? DEFAULT_HOSTNAMES).split(",").map((name) => name.trim()).filter(Boolean),
      });
    }
    if (request.method === "GET" || request.method === "HEAD") {
      return Response.redirect(`${origin}/docs/ai/`, 302);
    }
    return new Response(null, { status: 404 });
  },
};

export default worker;
