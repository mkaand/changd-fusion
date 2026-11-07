import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createRequire } from "node:module";
import { GitHubReleaseClient, extractReleaseManifest } from "./github-release-client.mjs";
const require=createRequire(new URL("../server/package.json",import.meta.url)),{ZipFile}=require("yazl");
const source="a".repeat(40),api=`ghcr.io/mkaand/changd-fusion-api@sha256:${"b".repeat(64)}`,ui=`ghcr.io/mkaand/changd-fusion-ui@sha256:${"c".repeat(64)}`;
const run={id:17,name:"GHCR immutable release",status:"completed",conclusion:"success",head_sha:source,repository:"mkaand/changd-fusion"};
const migrations=Array.from({length:18},(_,index)=>({name:`${String(index+1).padStart(3,"0")}_fixture.sql`,sha256:String((index%10)).repeat(64)}));
const manifest={source_sha:source,source_tree:"d".repeat(40),version:"0.3.3",api_image:api,ui_image:ui,architecture:"linux/amd64",api_worker_shared_image:api,workflow_run:"https://github.com/mkaand/changd-fusion/actions/runs/17",ci_evidence:"verified",created_at:"2026-01-01T00:00:00Z",migrations};
async function zip(entries){const value=new ZipFile();for(const [name,body]of entries)value.addBuffer(Buffer.from(body),name);value.end();const chunks=[];for await(const chunk of value.outputStream)chunks.push(chunk);return Buffer.concat(chunks)}
let server,base,archive,downloadAuthorization;
test.before(async()=>{archive=await zip([["release-manifest.json",JSON.stringify(manifest)]]);server=http.createServer((req,res)=>{if(req.url?.includes("workflows/ghcr"))return res.end(JSON.stringify({total_count:1,workflow_runs:[run]}));if(req.url?.includes("/runs/17/artifacts"))return res.end(JSON.stringify({total_count:1,artifacts:[{id:9,name:`ghcr-release-manifest-${source}`,expired:false}]}));if(req.url?.includes("/artifacts/9/zip")){res.statusCode=302;res.setHeader("location",`${base}/signed-download`);return res.end()}if(req.url==="/signed-download"){downloadAuthorization=req.headers.authorization;res.setHeader("content-length",archive.length);return res.end(archive)}res.statusCode=404;res.end("{}")});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${server.address().port}`});
test.after(()=>server.close());
test("downloads redirected Actions ZIP without leaking bearer credentials and validates manifest",async()=>{const client=new GitHubReleaseClient({baseUrl:base,token:"fixture-secret"});const result=await client.manifest(run);assert.equal(result.source_sha,source);assert.equal(result.api_image,api);assert.equal(downloadAuthorization,undefined)});
test("rejects malformed, missing and duplicate manifests",async()=>{await assert.rejects(extractReleaseManifest(Buffer.from("not zip"),run,"mkaand/changd-fusion"),/invalid_zip/);await assert.rejects(extractReleaseManifest(await zip([["other.json","{}"]]),run,"mkaand/changd-fusion"),/missing_manifest/);await assert.rejects(extractReleaseManifest(await zip([["release-manifest.json",JSON.stringify(manifest)],["release-manifest.json","{}"]]),run,"mkaand/changd-fusion"),/duplicate_manifest/)});
test("rejects manifest SHA, digest and architecture mismatches",async()=>{for(const changed of [{source_sha:"e".repeat(40)},{api_image:"latest"},{architecture:"linux/arm64"}])await assert.rejects(extractReleaseManifest(await zip([["release-manifest.json",JSON.stringify({...manifest,...changed})]]),run,"mkaand/changd-fusion"),/invalid_manifest/)});
test("rejects missing, unsorted or malformed migration evidence",async()=>{for(const changed of [{migrations:undefined},{migrations:[...migrations].reverse()},{migrations:[...migrations.slice(0,-1),{name:"018_fixture.sql",sha256:"bad"}]}])await assert.rejects(extractReleaseManifest(await zip([["release-manifest.json",JSON.stringify({...manifest,...changed})]]),run,"mkaand/changd-fusion"),/invalid_manifest/)});
test("rejects untrusted redirects and HTTP errors",async()=>{const badFetch=async()=>new Response(null,{status:302,headers:{location:"http://evil.invalid/file"}});await assert.rejects(new GitHubReleaseClient({fetchImpl:badFetch,token:"secret"}).downloadArtifact(1),/untrusted_artifact_redirect/);await assert.rejects(new GitHubReleaseClient({baseUrl:base}).request("/missing"),/github_http_404/)});


const ancestorSha = "a".repeat(40);
const descendantSha = "e".repeat(40);
const comparePath = "/repos/mkaand/changd-fusion/compare/" + ancestorSha + "..." + descendantSha;
const validCompare = {
  url: "https://api.github.com" + comparePath,
  status: "ahead",
  base_commit: { sha: ancestorSha },
  merge_base_commit: { sha: ancestorSha },
  ahead_by: 38,
  behind_by: 0,
  total_commits: 38,
  commits: [
    ...Array.from({ length: 37 }, (_, index) => ({ sha: (index + 1).toString(16).padStart(40, "0") })),
    { sha: descendantSha },
  ],
};

function compareClient(document = validCompare, link = "") {
  const client = new GitHubReleaseClient();
  client.request = async (path) => {
    assert.equal(path, comparePath, "only the exact expected SHA comparison is authorized");
    return { json: document, link };
  };
  return client;
}

test("accepts real GitHub Compare contract with no head_commit field", async () => {
  assert.equal("head_commit" in validCompare, false);
  assert.equal(await compareClient().sourceLineage(ancestorSha, descendantSha), true);
  const client = compareClient();
  assert.equal(await client.sourceLineage(ancestorSha, ancestorSha), true);
});

test("rejects wrong ancestry status, URL, merge base, SHA or incomplete evidence", async () => {
  const wrong = "f".repeat(40);
  const variations = [
    { status: "behind" },
    { status: "diverged" },
    { status: "identical" },
    { base_commit: { sha: wrong } },
    { merge_base_commit: { sha: wrong } },
    { url: "https://api.github.com/repos/mkaand/changd-fusion/compare/" + ancestorSha + "..." + wrong },
    { ahead_by: 0 },
    { ahead_by: 37 },
    { behind_by: 1 },
    { total_commits: 0 },
    { commits: [] },
    { commits: [...validCompare.commits.slice(0, -1), { sha: wrong }] },
    { head_commit: { sha: wrong } },
  ];
  for (const changed of variations) {
    await assert.rejects(
      compareClient({ ...validCompare, ...changed }).sourceLineage(ancestorSha, descendantSha),
      /untrusted_source_ancestry/,
      "rejected " + Object.keys(changed).join(", "),
    );
  }
  await assert.rejects(
    compareClient(validCompare, '<https://api.github.com/next>; rel="next"')
      .sourceLineage(ancestorSha, descendantSha),
    /ambiguous_compare/,
  );
});

test("handles truncated commit lists without trusting their last entry as the head", async () => {
  // GitHub may limit the unpaginated commits array to 250; the exact canonical
  // compare URL, status and merge-base still bind the requested descendant.
  const larger = {
    ...validCompare,
    ahead_by: 301,
    total_commits: 301,
    commits: validCompare.commits.slice(0, 37),
  };
  assert.equal(await compareClient(larger).sourceLineage(ancestorSha, descendantSha), true);
  await assert.rejects(
    compareClient({ ...larger, url: validCompare.url.replace(descendantSha, "f".repeat(40)) })
      .sourceLineage(ancestorSha, descendantSha),
    /untrusted_source_ancestry/,
  );
});

test("historical client CI uses only evidence completed before publisher start", async () => {
  const successful = { id: 42338055848, name: "CI", path: ".github/workflows/ci.yml",
    head_sha: source, status: "completed", conclusion: "success", run_attempt: 1,
    created_at: "2026-11-07T04:20:58Z", updated_at: "2026-11-07T04:25:21Z" };
  const cancelled = { ...successful, id: 42351306900, conclusion: "cancelled",
    created_at: "2026-11-07T07:26:43Z", updated_at: "2026-11-07T07:27:39Z" };
  const requiredJobs = ["verify", "privacy", "docker", "docker-arm64"].map((name) => ({
    name, status: "completed", conclusion: "success", run_attempt: 1,
  }));
  const client = new GitHubReleaseClient();
  const calls = [];
  client.request = async (path) => {
    calls.push(path);
    if (path.includes("/actions/runs?head_sha=")) return {
      json: { total_count: 2, workflow_runs: [cancelled, successful] }, link: "",
    };
    if (path === "/repos/mkaand/changd-fusion/actions/runs/42338055848/jobs?filter=latest&per_page=100") return {
      json: { total_count: requiredJobs.length, jobs: requiredJobs }, link: "",
    };
    throw Error("unexpected_api_request");
  };
  await assert.rejects(client.ci(source), /latest trusted CI workflow run is not successful/);
  const result = await client.ci(source, { publishedAt: "2026-11-07T04:25:23Z" });
  assert.deepEqual(Object.keys(result).sort(), ["verify", "privacy", "docker", "docker-arm64"].sort());
  assert.ok(Object.values(result).every((value) => value === "success"));
  assert.equal(calls.filter((x) => x.includes("/42338055848/jobs?")).length, 1);
});
