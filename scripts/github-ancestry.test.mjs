import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { GitHubReleaseClient } from "./github-release-client.mjs";

const source = "a".repeat(40);
const head = "b".repeat(40);

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return await run(new GitHubReleaseClient({ baseUrl }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function json(response, value) {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

test("accepts a concrete ancestor and an identical trusted master commit", async () => {
  await withServer((request, response) => {
    if (request.url?.endsWith("/commits/master")) return json(response, { sha: head });
    if (request.url?.includes(`/compare/${source}...${head}`)) {
      return json(response, {
        status: "ahead",
        base_commit: { sha: source },
        merge_base_commit: { sha: source },
        head_commit: { sha: head },
      });
    }
    response.statusCode = 404;
    return response.end("{}");
  }, async (client) => assert.equal(await client.masterLineage(source), true));

  let compared = false;
  await withServer((request, response) => {
    if (request.url?.endsWith("/commits/master")) return json(response, { sha: source });
    compared = true;
    response.statusCode = 500;
    return response.end();
  }, async (client) => assert.equal(await client.masterLineage(source), true));
  assert.equal(compared, false);
});

test("rejects divergent, unrelated and incorrect merge-base evidence", async () => {
  for (const compare of [
    { status: "diverged", base_commit: { sha: source }, merge_base_commit: { sha: "c".repeat(40) }, head_commit: { sha: head } },
    { status: "ahead", base_commit: { sha: source }, merge_base_commit: { sha: "c".repeat(40) }, head_commit: { sha: head } },
    { status: "ahead", base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: source }, head_commit: { sha: head } },
  ]) {
    await withServer((request, response) => {
      if (request.url?.endsWith("/commits/master")) return json(response, { sha: head });
      return json(response, compare);
    }, async (client) => assert.rejects(client.masterLineage(source), /untrusted_source_ancestry/));
  }
});

test("rejects invalid commits and malformed or failed API evidence", async () => {
  await withServer((_request, response) => json(response, { sha: "short" }), async (client) => {
    await assert.rejects(client.masterLineage(source), /malformed_master/);
    await assert.rejects(client.masterLineage("not-a-sha"), /invalid_sha/);
  });
  await withServer((_request, response) => {
    response.statusCode = 403;
    response.end("{}");
  }, async (client) => assert.rejects(client.masterLineage(source), /github_http_403/));
  await withServer((request, response) => {
    if (request.url?.endsWith("/commits/master")) return json(response, { sha: head });
    response.setHeader("link", '<https://api.github.test/next>; rel="next"');
    return json(response, {
      status: "ahead",
      base_commit: { sha: source },
      merge_base_commit: { sha: source },
      head_commit: { sha: head },
    });
  }, async (client) => assert.rejects(client.masterLineage(source), /ambiguous_compare/));
});
