import assert from "node:assert/strict";
import { test } from "node:test";

import { chunksOf, clearCorpusCache, getCorpus, parseIndex, tokenize, type Fetch } from "../src/corpus.ts";
import worker, { limitKey } from "../src/index.ts";
import { handleMcp, pageId } from "../src/mcp.ts";

const ORIGIN = "https://cofferdam.xyz";

const INDEX = `# Cofferdam

> Docs.

## Documentation

- [Quick start](${ORIGIN}/docs/sdk/quickstart.md): Sign a test user in with the mock provider.
- **SDK**
- [Verify a session](${ORIGIN}/docs/sdk/verify-session.md): Check a csa1 session attestation on your server.

## Optional

- [Every page](${ORIGIN}/llms-full.txt)
- [Elsewhere](https://example.com/other.md): not ours
`;

const PAGES: Record<string, string> = {
  "/docs/sdk/quickstart.md": "# Quick start\n\nSign a mock user in.\n\n## Test users [#test-users]\n\n`mockProfiles` has five named users.\n\n```md\n## not a heading\n```\n",
  "/docs/sdk/verify-session.md":
    "# Verify a session\n\nA sign-in returns a `csa1:` token.\n\n## Verify with the SDK\n\nCall `decodeAndVerifySessionAttestation(token, { maxAgeMs })`.\n\n## What a valid token proves\n\nUse checkOnChain to confirm the key controls the account.\n",
};

function fixture(calls: string[] = []): Fetch {
  return async (input) => {
    calls.push(input);
    if (input === `${ORIGIN}/llms.txt`) return new Response(INDEX);
    const page = PAGES[input.slice(ORIGIN.length)];
    return page ? new Response(page) : new Response("not found", { status: 404 });
  };
}

/** What the two tools return, as far as these tests read it. */
interface Structured {
  results: { id: string; title: string; url: string; text: string }[];
  id: string;
  text: string;
}
interface ToolResult {
  content: { text: string }[];
  structuredContent: Structured;
  isError?: boolean;
}
interface Initialized {
  protocolVersion: string;
  serverInfo: { name: string };
  capabilities: { tools?: unknown };
}
interface Rpc<T> {
  result?: T;
  error?: { code: number; message: string };
}

/** The server's own address. A real request always carries `Host`; Node's `Request` adds none, so the tests set it. */
const ENDPOINT = "https://docs.cofferdam.xyz/mcp";
const HOSTNAMES = ["docs.cofferdam.xyz"];
/** What a client of the revisions before 2026-07-28 sends: the transport refuses any other `Accept`. */
const LEGACY = { host: "docs.cofferdam.xyz", "content-type": "application/json", accept: "application/json, text/event-stream" };

/** A 2026-07-28 request: the version and method in headers, and the per-request envelope in `params._meta`. */
function modern(id: number, method: string, params: Record<string, unknown> = {}, name?: string): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      host: "docs.cofferdam.xyz",
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } },
    }),
  });
}

function post(body: unknown, headers: Record<string, string> = {}, url = ENDPOINT): Request {
  return new Request(url, { method: "POST", headers: { ...LEGACY, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function rpc(fetcher: Fetch, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handleMcp(post(body, headers), { origin: ORIGIN, fetcher, hostnames: HOSTNAMES });
}

/** The JSON-RPC message of a response: a JSON body, or the one event of the older revisions' stream. */
async function message<T>(response: Response): Promise<Rpc<T>> {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text) as Rpc<T>;
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data, `no event in ${text}`);
  return JSON.parse(data.slice(6)) as Rpc<T>;
}

async function call(fetcher: Fetch, name: string, args: unknown) {
  const response = await rpc(fetcher, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.status, 200);
  return message<ToolResult>(response);
}

test("the index parser keeps this site's pages only", () => {
  const entries = parseIndex(INDEX, ORIGIN);
  assert.deepEqual(entries.map((entry) => entry.id), ["/docs/sdk/quickstart", "/docs/sdk/verify-session"]);
  assert.equal(entries[0]?.url, `${ORIGIN}/docs/sdk/quickstart`);
  assert.equal(entries[1]?.description, "Check a csa1 session attestation on your server.");
});

test("a page is chunked at its headings, not inside code fences", () => {
  const chunks = chunksOf({ id: "/q", title: "Quick start", description: "", url: "", markdownUrl: "", text: PAGES["/docs/sdk/quickstart.md"]! });
  assert.deepEqual(chunks.map((chunk) => chunk.heading), ["Quick start", "Test users"]);
  assert.match(chunks[1]!.text, /## not a heading/);
});

test("identifiers are searchable whole and by their parts", () => {
  const words = tokenize("Call `checkOnChain` with a csa1: token from @cofferdam/sdk.");
  for (const word of ["checkonchain", "check", "chain", "csa1", "@cofferdam/sdk", "sdk"]) assert.ok(words.includes(word), word);
});

test("initialize answers statelessly with the tools capability", async () => {
  clearCorpusCache();
  const response = await rpc(fixture(), { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), null);
  const { result } = await message<Initialized>(response);
  assert.equal(result!.protocolVersion, "2025-06-18");
  assert.equal(result!.serverInfo.name, "cofferdam-docs");
  assert.ok(result!.capabilities.tools);
});

test("an unknown protocol version is answered with the newest one of the earlier revisions", async () => {
  const response = await rpc(fixture(), { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal((await message<Initialized>(response)).result!.protocolVersion, "2025-11-25");
});

test("the oldest revision still served is 2024-11-05", async () => {
  const response = await rpc(fixture(), { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal((await message<Initialized>(response)).result!.protocolVersion, "2024-11-05");
});

test("notifications get 202, GET gets 405, and an earlier-revision client must accept an event stream", async () => {
  assert.equal((await rpc(fixture(), { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const get = await handleMcp(new Request(ENDPOINT, { headers: { host: "docs.cofferdam.xyz" } }), { origin: ORIGIN, fetcher: fixture(), hostnames: HOSTNAMES });
  assert.equal(get.status, 405);
  assert.equal((await rpc(fixture(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, { accept: "application/json" })).status, 406);
});

interface Listed {
  tools: { name: string; annotations: { readOnlyHint: boolean }; inputSchema: { additionalProperties?: boolean; required?: string[] }; outputSchema?: unknown }[];
}

test("tools/list offers search and fetch, both read-only, in the shapes a search connector needs", async () => {
  const response = await rpc(fixture(), { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const { result } = await message<Listed>(response);
  assert.deepEqual(result!.tools.map((tool) => tool.name), ["search", "fetch"]);
  assert.ok(result!.tools.every((tool) => tool.annotations.readOnlyHint === true));
  assert.deepEqual(result!.tools.map((tool) => tool.inputSchema.required), [["query"], ["id"]]);
  assert.ok(result!.tools.every((tool) => tool.inputSchema.additionalProperties === false && tool.outputSchema));
});

test("revision 2026-07-28 is served on the same address: discover, list and call, answered as JSON", async () => {
  clearCorpusCache();
  const options = { origin: ORIGIN, fetcher: fixture(), hostnames: HOSTNAMES };
  const discover = await handleMcp(modern(1, "server/discover"), options);
  assert.equal(discover.status, 200);
  assert.match(discover.headers.get("content-type") ?? "", /application\/json/);
  const discovered = (await discover.json()) as Rpc<{ supportedVersions: string[]; _meta: Record<string, { name: string }> }>;
  assert.deepEqual(discovered.result!.supportedVersions, ["2026-07-28"]);
  assert.equal(discovered.result!._meta["io.modelcontextprotocol/serverInfo"]?.name, "cofferdam-docs");

  const listed = (await (await handleMcp(modern(2, "tools/list"), options)).json()) as Rpc<Listed>;
  assert.deepEqual(listed.result!.tools.map((tool) => tool.name), ["search", "fetch"]);

  const called = (await (await handleMcp(modern(3, "tools/call", { name: "search", arguments: { query: "mock users" } }, "search"), options)).json()) as Rpc<ToolResult>;
  assert.equal(called.result!.structuredContent.results[0]?.id, "/docs/sdk/quickstart");
});

test("a 2026-07-28 request without its envelope, or whose headers disagree with its body, is refused", async () => {
  const options = { origin: ORIGIN, fetcher: fixture(), hostnames: HOSTNAMES };
  const bare = await rpc(fixture(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" });
  assert.equal(bare.status, 400);
  const lying = modern(2, "tools/list");
  lying.headers.set("mcp-method", "tools/call");
  assert.equal((await handleMcp(lying, options)).status, 400);
});

test("only the server's own hostnames are answered, and a browser may call from the site or localhost only", async () => {
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  assert.equal((await rpc(fixture(), list, { host: "evil.example" })).status, 403);
  assert.equal((await rpc(fixture(), list, { origin: "https://evil.example" })).status, 403);
  assert.equal((await rpc(fixture(), list, { origin: "https://cofferdam.xyz" })).status, 200);
  assert.equal((await rpc(fixture(), list, { origin: "http://localhost:6274" })).status, 200);
  // No Origin at all is every client that is not a web page.
  assert.equal((await rpc(fixture(), list)).status, 200);
  const preflight = await handleMcp(new Request(ENDPOINT, { method: "OPTIONS", headers: { host: "docs.cofferdam.xyz", origin: "https://cofferdam.xyz" } }), { origin: ORIGIN, fetcher: fixture(), hostnames: HOSTNAMES });
  assert.equal(preflight.status, 200);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Mcp-Method/);
});

test("search returns the matching section with the page id and address", async () => {
  clearCorpusCache();
  const { result } = await call(fixture(), "search", { query: "checkOnChain key controls account" });
  const hits = result!.structuredContent.results;
  assert.equal(hits[0]?.id, "/docs/sdk/verify-session");
  assert.equal(hits[0]?.title, "Verify a session: What a valid token proves");
  assert.equal(hits[0]?.url, `${ORIGIN}/docs/sdk/verify-session`);
  assert.deepEqual(JSON.parse(result!.content[0]!.text), result!.structuredContent);
});

test("search with no match returns an empty list, not an error", async () => {
  const { result } = await call(fixture(), "search", { query: "zzzzqqqq" });
  assert.deepEqual(result!.structuredContent, { results: [] });
  assert.notEqual(result!.isError, true);
});

test("fetch returns the page by id, by address and by .md address", async () => {
  for (const id of ["/docs/sdk/quickstart", `${ORIGIN}/docs/sdk/quickstart/`, `${ORIGIN}/docs/sdk/quickstart.md`, "docs/sdk/quickstart#test-users"]) {
    const { result } = await call(fixture(), "fetch", { id });
    assert.equal(result!.structuredContent.id, "/docs/sdk/quickstart", id);
    assert.match(result!.structuredContent.text, /mockProfiles/);
  }
  assert.equal(pageId("/docs/", ORIGIN), "/docs");
});

test("fetch of a page that is not published is a tool error, and reads nothing else", async () => {
  clearCorpusCache();
  const calls: string[] = [];
  const { result } = await call(fixture(calls), "fetch", { id: "https://evil.example/secret" });
  assert.equal(result!.isError, true);
  assert.ok(calls.every((url) => url.startsWith(`${ORIGIN}/`)), calls.join(" "));
});

test("the corpus is loaded once and reused", async () => {
  clearCorpusCache();
  const calls: string[] = [];
  const fetcher = fixture(calls);
  await call(fetcher, "search", { query: "mock" });
  await call(fetcher, "search", { query: "token" });
  assert.equal(calls.filter((url) => url.endsWith("/llms.txt")).length, 1);
});

test("a site that cannot be read is a tool error, is not fetched again at once, and recovers", async () => {
  clearCorpusCache();
  let down = true;
  const calls: string[] = [];
  const good = fixture();
  const fetcher: Fetch = async (input) => {
    calls.push(input);
    return down ? new Response("down", { status: 503 }) : good(input);
  };
  assert.equal((await call(fetcher, "search", { query: "mock" })).result!.isError, true);
  assert.equal((await call(fetcher, "search", { query: "mock" })).result!.isError, true);
  assert.equal(calls.length, 2, "the index was read and tried once more, and the failure is then remembered for a moment");
  down = false;
  clearCorpusCache();
  const recovered = await call(fetcher, "search", { query: "mock" });
  assert.equal(recovered.result!.structuredContent.results[0]?.id, "/docs/sdk/quickstart");
});

test("a read that fails once is tried once more, and a missing page is not", async () => {
  clearCorpusCache();
  const calls: string[] = [];
  const good = fixture();
  const flaky: Fetch = async (input) => {
    calls.push(input);
    const tries = calls.filter((url) => url === input).length;
    if (input.endsWith("/quickstart.md") && tries === 1) throw new Error("Network connection lost.");
    if (input.endsWith("/verify-session.md") && tries === 1) return new Response("busy", { status: 503 });
    return good(input);
  };
  const corpus = await getCorpus(ORIGIN, flaky, 0);
  assert.equal(corpus.docs.length, 2);
  assert.equal(calls.length, 5, calls.join(" "));

  clearCorpusCache();
  const asked: string[] = [];
  const missing: Fetch = async (input) => (asked.push(input), input.endsWith("/llms.txt") ? good(input) : new Response("no", { status: 404 }));
  await assert.rejects(getCorpus(ORIGIN, missing, 0), /answered 404/);
  assert.equal(asked.length, 3, "one index and two pages, none asked twice");
});

test("a failed load is forgotten after fifteen seconds and a good one after five minutes", async () => {
  clearCorpusCache();
  const calls: string[] = [];
  const failing: Fetch = async (input) => {
    calls.push(input);
    return new Response("down", { status: 503 });
  };
  await assert.rejects(getCorpus(ORIGIN, failing, 1_000));
  await assert.rejects(getCorpus(ORIGIN, failing, 10_000));
  assert.equal(calls.length, 2, "one load: the index and its second try");
  await assert.rejects(getCorpus(ORIGIN, failing, 17_000));
  assert.equal(calls.length, 4);

  clearCorpusCache();
  const loads: string[] = [];
  await getCorpus(ORIGIN, fixture(loads), 0);
  await getCorpus(ORIGIN, fixture(loads), 299_000);
  assert.equal(loads.filter((url) => url.endsWith("/llms.txt")).length, 1);
  await getCorpus(ORIGIN, fixture(loads), 301_000);
  assert.equal(loads.filter((url) => url.endsWith("/llms.txt")).length, 2);
});

test("a message that is not a request is an error, never a silent 202", async () => {
  for (const body of [{}, [1], { jsonrpc: "2.0" }, { jsonrpc: "1.0", id: 1, method: "ping" }]) {
    const response = await rpc(fixture(), body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(((await response.json()) as Rpc<never>).error?.code, -32600, JSON.stringify(body));
  }
});

test("bad input is refused: no query, long query, an extra argument, unknown tool, unknown method, bad JSON, big body", async () => {
  // Bad arguments come back as a tool error the model can read and correct, as the 2025-11-25 revision asks.
  for (const args of [{}, { query: "" }, { query: "x".repeat(501) }, { query: "mock", limit: 3 }]) {
    const { result } = await call(fixture(), "search", args);
    assert.equal(result!.isError, true, JSON.stringify(args));
    assert.match(result!.content[0]!.text, /Input validation error/);
  }
  assert.equal((await call(fixture(), "delete_everything", {})).error!.code, -32602);
  const unknown = await message<never>(await rpc(fixture(), { jsonrpc: "2.0", id: 3, method: "resources/list" }));
  assert.equal(unknown.error!.code, -32601);
  const bad = await rpc(fixture(), "{");
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as Rpc<never>).error!.code, -32700);
  const big = await rpc(fixture(), { pad: "x".repeat(70_000) });
  assert.equal(big.status, 413);
  // The cap counts bytes, and holds without a Content-Length: 30,000 three-byte characters, streamed.
  const stream = new Blob([JSON.stringify({ pad: "\u20ac".repeat(30_000) })]).stream();
  const streamed = await handleMcp(new Request(ENDPOINT, { method: "POST", headers: LEGACY, body: stream, duplex: "half" } as RequestInit), { origin: ORIGIN, fetcher: fixture(), hostnames: HOSTNAMES });
  assert.equal(streamed.status, 413);
});

test("the Worker routes /mcp and sends browsers to the docs", async () => {
  const redirect = await worker.fetch(new Request("https://docs.cofferdam.xyz/"), {});
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://cofferdam.xyz/docs/ai/");
  assert.equal((await worker.fetch(new Request("https://docs.cofferdam.xyz/other", { method: "POST" }), {})).status, 404);
  // The Worker answers on docs.cofferdam.xyz unless MCP_HOSTNAMES names others.
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  assert.equal((await worker.fetch(post(list), {})).status, 200);
  assert.equal((await worker.fetch(post(list, { host: "docs.staging.example" }, "https://docs.staging.example/mcp"), {})).status, 403);
  assert.equal((await worker.fetch(post(list, { host: "docs.staging.example" }, "https://docs.staging.example/mcp"), { MCP_HOSTNAMES: "docs.cofferdam.xyz, docs.staging.example" })).status, 200);
});

test("the Worker fetches the same paths from DOCS_FETCH_ORIGIN and still answers with the published addresses", async () => {
  clearCorpusCache();
  const real = globalThis.fetch;
  const asked: string[] = [];
  const pages = fixture();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    return pages(url.replace("http://localhost:4324", ORIGIN));
  }) as typeof fetch;
  try {
    const response = await worker.fetch(post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "mock users" } } }), {
      DOCS_FETCH_ORIGIN: "http://localhost:4324/",
    });
    const { result } = await message<ToolResult>(response);
    assert.equal(result!.structuredContent.results[0]?.url, `${ORIGIN}/docs/sdk/quickstart`);
    assert.ok(asked.length > 0 && asked.every((url) => url.startsWith("http://localhost:4324/")), asked.join(" "));
  } finally {
    globalThis.fetch = real;
    clearCorpusCache();
  }
});

test("a caller over the limit gets 429 before anything is read, and others are untouched", async () => {
  const asked: string[] = [];
  const limiter = { limit: async ({ key }: { key: string }) => (asked.push(key), { success: key !== "203.0.113.9" }) };
  const from = (address?: string) =>
    worker.fetch(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, address ? { "cf-connecting-ip": address } : {}), { DOCS_MCP_RL: limiter });

  const limited = await from("203.0.113.9");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(limited.headers.get("access-control-allow-origin"), "*");
  assert.equal(((await limited.json()) as { error: { code: number } }).error.code, -32029);

  assert.equal((await from("198.51.100.7")).status, 200);
  assert.equal((await from()).status, 200);
  assert.deepEqual(asked, ["203.0.113.9", "198.51.100.7", "no-address"], "a request with no address is counted under one shared key");
});

test("a limiter that fails does not take the docs down, and preflight is never counted", async () => {
  let calls = 0;
  const broken = { limit: async (): Promise<{ success: boolean }> => (calls++, Promise.reject(new Error("limiter down"))) };
  const headers = { host: "docs.cofferdam.xyz", "cf-connecting-ip": "203.0.113.9" };
  const ok = await worker.fetch(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, headers), { DOCS_MCP_RL: broken });
  assert.equal(ok.status, 200);
  assert.equal(calls, 1);
  assert.equal((await worker.fetch(new Request(ENDPOINT, { method: "OPTIONS", headers }), { DOCS_MCP_RL: broken })).status, 200);
  assert.equal((await worker.fetch(new Request(ENDPOINT, { headers }), { DOCS_MCP_RL: broken })).status, 405);
  assert.equal(calls, 1);
});

test("a batch is refused, so one counted request is one call", async () => {
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  for (const body of [[list], [list, { ...list, id: 2 }], "  \n[" + JSON.stringify(list) + "]"]) {
    const response = await rpc(fixture(), body);
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as Rpc<never>).error!.code, -32600);
  }
});

test("a subscription is refused on both generations, so no stream is held open", async () => {
  const options = { origin: ORIGIN, fetcher: fixture(), hostnames: HOSTNAMES };
  const modernListen = await handleMcp(modern(1, "subscriptions/listen", { subscriptions: { toolsListChanged: true } }), options);
  assert.equal(modernListen.status, 400);
  assert.match(modernListen.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(((await modernListen.json()) as Rpc<never>).error!.code, -32601);
  const legacyListen = await rpc(fixture(), { jsonrpc: "2.0", id: 2, method: "subscriptions/listen", params: {} });
  assert.equal(legacyListen.status, 400);
});

test("a declared length over the cap is refused without reading, and a limited caller's body is never read", async () => {
  let pulled = false;
  const body = () =>
    // No buffer of its own, so `pull` runs only when someone reads.
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
  const options = { origin: ORIGIN, fetcher: fixture(), hostnames: HOSTNAMES };
  const declared = await handleMcp(new Request(ENDPOINT, { method: "POST", headers: { ...LEGACY, "content-length": "70000" }, body: body(), duplex: "half" } as RequestInit), options);
  assert.equal(declared.status, 413);
  assert.equal(pulled, false, "the body was read although its declared length was over the cap");
  const limited = await handleMcp(new Request(ENDPOINT, { method: "POST", headers: LEGACY, body: body(), duplex: "half" } as RequestInit), { ...options, overLimit: async () => true });
  assert.equal(limited.status, 429);
  assert.equal(pulled, false, "the body was read although the caller was over its limit");
});

test("the rate limit counts an IPv6 caller by its /64, an IPv4 caller by its address", () => {
  assert.equal(limitKey("203.0.113.9"), "203.0.113.9");
  assert.equal(limitKey(null), "no-address");
  assert.equal(limitKey("2001:db8:12:3400:aaaa:bbbb:cccc:dddd"), "2001:db8:12:3400::/64");
  assert.equal(limitKey("2001:DB8:12:3400::1"), limitKey("2001:db8:12:3400:ffff:ffff:ffff:ffff"));
  assert.equal(limitKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.notEqual(limitKey("2001:db8:12:3400::1"), limitKey("2001:db8:12:3401::1"));
  assert.equal(limitKey("::1"), "0:0:0:0::/64");
});

