# Cofferdam developer docs

The developer documentation for [Cofferdam](https://cofferdam.xyz), written to be read by coding agents as well as by people, and the MCP server that lets an agent search and read it.

Cofferdam is a way for an app to sign people in with a passkey and get a session its server can verify, without receiving a name, an email address, a passport or a phone number. The SDK (`@cofferdam/sdk`, MIT) is pre-release: read these pages, not what a model remembers.

## Read the docs

- On the web: <https://cofferdam.xyz/docs>
- As Markdown, for an agent: add `.md` to any page's address, or start from the index, <https://cofferdam.xyz/llms.txt>.
- In this repository: [`content/docs/`](content/docs), one MDX file per page.

Every page on the site has a **Copy prompt** button: it copies a short prompt that tells your agent which page to read and what to do with it.

## Plug the docs into an agent

**The docs MCP server** ([`mcp/`](mcp)) is a public, read-only server with two tools: `search` finds the section that answers a question, and `fetch` returns a whole page as Markdown. It needs no account and no key, and it can only read these public pages: it has no way to reach a Cofferdam account.

Its address will be `https://docs.cofferdam.xyz/mcp`. It is not live yet; this file says so until it is.

**Skills** for coding agents are in [cofferdam-skills](https://github.com/cofferdamxyz/cofferdam-skills).

## What is in this repository

| Path | What |
| --- | --- |
| `content/docs/` | The pages, in MDX. `meta.json` sets their order in the sidebar. |
| `mcp/` | The docs MCP server, a Cloudflare Worker, with its tests. |

The website that renders the pages is a separate project. It takes this content at a pinned commit when it is built, so a change here appears on cofferdam.xyz once the site moves to that commit.

## Run the server's tests

Node 22.18 or later and yarn 1.

```bash
cd mcp
yarn install --frozen-lockfile
yarn test
```

## Contribute

Corrections are welcome: open an issue or a pull request. A page states what the SDK and the API do today, and each code sample is run against them before it is published, so a pull request that changes a fact should say where in [cofferdam-sdk](https://github.com/cofferdamxyz/cofferdam-sdk) or [cofferdam-api](https://github.com/cofferdamxyz/cofferdam-api) it comes from.

## Licence

[MIT](LICENSE).
