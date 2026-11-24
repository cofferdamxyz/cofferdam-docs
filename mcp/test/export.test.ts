import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { clearCorpusCache, getCorpus, type Fetch } from "../src/corpus.ts";
import { search } from "../src/search.ts";

/**
 * The server against what the site really publishes: a static export of the
 * website, whose folder `SITE_EXPORT` names. Without it the test looks for a
 * checkout of the site beside this repository, and is skipped when there is
 * no export, so `yarn test` also runs on a fresh clone and in CI.
 */
const out = process.env.SITE_EXPORT
  ? resolve(process.env.SITE_EXPORT)
  : resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "cofferdam-pages", "out");
const ORIGIN = "https://cofferdam.xyz";

const fromExport: Fetch = async (input) => {
  const path = join(out, input.slice(ORIGIN.length));
  return existsSync(path) ? new Response(readFileSync(path, "utf8")) : new Response("not found", { status: 404 });
};

test("the exported site loads as a corpus and answers real questions", { skip: !existsSync(join(out, "llms.txt")) }, async () => {
  clearCorpusCache();
  const corpus = await getCorpus(ORIGIN, fromExport);
  assert.ok(corpus.docs.length >= 7, `${corpus.docs.length} pages`);
  assert.ok(corpus.docs.every((doc) => doc.text.startsWith("# ")));

  const expectations: [query: string, page: string][] = [
    ["install the sdk release branch", "/docs/sdk/installation"],
    ["mockProfiles verified-br", "/docs/sdk/quickstart"],
    ["SignInWithCofferdamButton props", "/docs/sdk/react"],
    ["decodeAndVerifySessionAttestation maxAgeMs", "/docs/sdk/verify-session"],
    ["account_not_deployed authority status", "/docs/api/verify-attestation"],
    ["llms.txt copy prompt", "/docs/ai"],
    ["push relay sealed device token", "/blog/xmtp-on-cloudflare"],
  ];
  for (const [query, page] of expectations) {
    assert.equal(search(corpus, query)[0]?.id, page, query);
  }
});
