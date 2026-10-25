// Synthetic Docker-only recovery test. It proves the UI proxy re-resolves the
// API service after Docker replaces that container and assigns a new IP.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const suffix = `${process.pid}-${Date.now()}`;
const network = `fusion-nginx-dns-${suffix}`;
const ui = `fusion-ui-${suffix}`;
const firstApi = `fusion-api-old-${suffix}`;
const secondApi = `fusion-api-new-${suffix}`;
const nodeImage = "node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const apiServer = "const http=require('node:http');http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({version:process.env.VERSION,path:req.url,proto:req.headers['x-forwarded-proto'],host:req.headers.host,upgrade:req.headers.upgrade||null}));}).listen(8000);";

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000, ...options });
  if (result.error || result.status !== 0) throw Error(result.stderr || result.error?.message || "Docker command failed");
  return result.stdout.trim();
}

function startApi(name, version) {
  docker(["run", "-d", "--rm", "--name", name, "--network", network, "--network-alias", "api", "-e", `VERSION=${version}`, nodeImage, "node", "-e", apiServer]);
}

function throughProxy() {
  const script = "const response=await fetch('http://ui:8080/api/health');if(!response.ok)process.exit(1);console.log(await response.text());";
  return JSON.parse(docker(["run", "--rm", "--network", network, nodeImage, "node", "--input-type=module", "-e", script]));
}

async function eventually(version) {
  let last;
  for (let attempt = 0; attempt < 24; attempt++) {
    try {
      const response = throughProxy();
      if (response.version === version) return response;
      last = Error(`received stale API response ${response.version}`);
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw last ?? Error("API proxy did not recover");
}

try {
  docker(["network", "create", network]);
  startApi(firstApi, "old");
  docker(["run", "-d", "--rm", "--name", ui, "--network", network, "--network-alias", "ui", process.env.FUSION_UI_IMAGE ?? "changd-fusion-ui:ci"]);
  const initial = await eventually("old");
  assert.equal(initial.path, "/api/health");
  assert.equal(initial.proto, "http");
  assert.equal(initial.host, "ui");
  assert.equal(initial.upgrade, null);
  docker(["rm", "-f", firstApi]);
  startApi(secondApi, "new");
  const recovered = await eventually("new");
  assert.equal(recovered.path, "/api/health");
  console.log("PASS: Nginx re-resolves a replaced Docker API container");
} finally {
  for (const container of [ui, firstApi, secondApi]) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
}
