// A Chromium browser tree can briefly fork before its children receive a
// --type switch. Count only candidate processes without a candidate parent.
// Separate browser launches remain separate roots.
export function browserProcessRoots(candidates) {
  const candidatePids = new Set(candidates.map(candidate => candidate.pid));
  return candidates.filter(candidate => !candidatePids.has(candidate.ppid));
}
