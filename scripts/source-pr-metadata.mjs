#!/usr/bin/env node
const shaPattern = /^[0-9a-f]{40}$/i;

export function verifiedSourcePr(input, sourceSha, repository = "mkaand/changd-fusion") {
  if (!shaPattern.test(sourceSha) || !Array.isArray(input)) return "";
  const matches = input.filter((pr) => pr && typeof pr === "object" &&
    pr.state === "closed" && pr.merged_at && pr.base?.ref === "master" &&
    pr.merge_commit_sha?.toLowerCase() === sourceSha.toLowerCase() &&
    (!pr.base?.repo?.full_name || pr.base.repo.full_name === repository) &&
    Number.isSafeInteger(pr.number) && pr.number > 0);
  return matches.length === 1 ? String(matches[0].number) : "";
}

if (import.meta.main) {
  const [file, sha] = process.argv.slice(2);
  const input = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"));
  process.stdout.write(verifiedSourcePr(input, sha));
}
