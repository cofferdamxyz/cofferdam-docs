# AGENTS Instructions

## Scope

Cofferdam's public developer documentation (`content/docs/`) and the docs MCP server (`mcp/`). This repository is public: everything in it is read by outside developers and their coding agents.

## Writing a page

- **The pattern, never the deployment.** No cost, size, region, limit, incident, internal host name or roadmap date. A page says what a developer can do and how; it never describes how Cofferdam runs its own service.
- **Every fact is checked against the code** in `cofferdam-sdk` and `cofferdam-api` before it ships, and every code sample is run. A change to the SDK's public surface or to a documented route updates its page in the same change.
- **Say what is built and what is not.** The SDK is pre-release; a planned feature is named as planned, never described as working.
- Developer docs use the technical words (passkey, escrow, on-chain, chain id). They are the one place Cofferdam's writing does.
- English only.
- A page is MDX with frontmatter: `title`, `description`, and optionally `prompt`, the task the site's "Copy prompt" button gives an agent for that page. Keep a prompt short enough to read in a tooltip.
- The only component is `<Callout>`. Links to other pages are absolute site paths (`/docs/sdk/quickstart`). `meta.json` orders the sidebar.
- The website is a separate project that fetches this folder at a pinned commit when it builds. Nothing here reaches cofferdam.xyz until that pin moves.

## The docs MCP server (`mcp/`)

- A Cloudflare Worker: public, unauthenticated, read-only. Two tools, `search` and `fetch`, in the shapes ChatGPT requires of a search connector.
- It answers only from what the site publishes: it reads `llms.txt` and the `.md` pages from `DOCS_ORIGIN` and keeps them in memory for five minutes. It must never gain a binding to a database, a store of user data or Cofferdam's API. Its one binding is a rate limit.
- The protocol layer is Cloudflare's `createMcpHandler` (`agents/mcp/server`) over `McpServer` from `@modelcontextprotocol/server`. Never hand-write protocol handling. `agents` requires one exact version of `@modelcontextprotocol/server`: bump the two together.
- No `account_id` in `wrangler.jsonc`, no secrets, no logs: a query is whatever an agent's user typed.
- yarn 1 only, never npm. Pin every dependency to an exact version that has been published for at least seven days.
- `cd mcp && yarn test` typechecks and runs the tests with Node's own runner (Node 22.18 or later, which strips the TypeScript types). `test/export.test.ts` runs against a real export of the website when `SITE_EXPORT` points at one, and is skipped otherwise.
- Deploys are made by Cofferdam's maintainers. CI never deploys and holds no token.

## Git

Commit with `git commit -s`, and with a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer naming the model when an agent wrote the change.
