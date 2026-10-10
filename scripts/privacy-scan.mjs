import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
const git = (args) =>
  execFileSync("git", args, { maxBuffer: 32 * 1024 * 1024 });
const names = (args) => git(args).toString().split("\0").filter(Boolean);
const files = new Set(
  [
    ...names(["ls-files", "-z"]),
    ...names(["ls-files", "--others", "--exclude-standard", "-z"]),
  ].filter((f) => existsSync(f) && statSync(f).isFile()),
);
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else files.add(file);
  }
}
walk("frontend/dist");
walk("server/dist");
const failures = [];
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  ],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["bot credential", /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/],
  [
    "credential assignment",
    /(?:JWT_SECRET|CHANNEL_KEY|SMTP_PASSWORD|TELEGRAM_TOKEN)\s*=\s*[a-zA-Z0-9_\-/+]{16,}/,
  ],
];
function scan(label, file, buffer) {
  if (
    /(^|\/)(?:\.env(?:\..*)?|backups?|data|screenshots)(?:\/|$)/.test(file) &&
    !file.endsWith(".env.example")
  ) {
    failures.push([label, "private runtime file"]);
    return;
  }
  if (buffer.includes(0)) return;
  const text = buffer.toString();
  for (const [category, re] of patterns)
    if (re.test(text)) failures.push([label, category]);
  for (const [email] of text.matchAll(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  ))
    if (
      !email.endsWith("@example.com") &&
      !email.endsWith("@example.invalid") &&
      email !== "codex@openai.com" &&
      !file.includes("package-lock.json")
    )
      failures.push([label, "non-fixture email"]);
  for (const value of (process.env.PRIVACY_FORBIDDEN_SUBSTRINGS ?? "")
    .split(",")
    .filter(Boolean))
    if (text.toLowerCase().includes(value.toLowerCase()))
      failures.push([label, "forbidden private identifier"]);
}
for (const file of files) scan(file, file, readFileSync(file));
let historicalFiles = 0;
const base = process.argv
  .find((a) => a.startsWith("--history="))
  ?.slice("--history=".length);
if (base) {
  // Inspect every changed file as it existed in every new commit, even if later removed.
  // Argument arrays prevent shell expansion; resolve the base before constructing ranges.
  const sha = git(["rev-parse", "--verify", base + "^{commit}"])
    .toString()
    .trim();
  for (const commit of git(["rev-list", sha + "..HEAD"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)) {
    for (const file of names([
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "--diff-filter=ACMR",
      "-z",
      commit,
    ])) {
      scan(
        commit.slice(0, 8) + ":" + file,
        file,
        git(["show", commit + ":" + file]),
      );
      historicalFiles++;
    }
  }
}
if (failures.length) {
  // Categories and filenames only: never print the matched private value.
  for (const [file, category] of failures)
    console.error(`${file}: ${category}`);
  process.exitCode = 1;
} else
  console.log(
    `Privacy scan passed: ${files.size} source/build files, ${historicalFiles} changed commit files. Manual domain/infrastructure review is still required.`,
  );
