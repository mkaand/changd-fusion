export type BuildMetadataInput = {
  version?: unknown;
  commit?: unknown;
  branch?: unknown;
  sourcePr?: unknown;
};

export type BuildMetadata = {
  version: string | null;
  commit: string | null;
  branch: string | null;
  sourcePr: number | null;
};

declare const __CHANGD_BUILD_METADATA__: BuildMetadataInput;

const commitPattern = /^[0-9a-f]{40}$/i;
const branchPattern = /^(?![/.])(?!.*(?:\.\.|@\{|[~^:?*\\[\]{}\s]))[A-Za-z0-9._/-]{1,255}(?<![/.])$/;

export function normalizeBuildMetadata(input: BuildMetadataInput): BuildMetadata {
  const version = typeof input.version === "string" && input.version.trim() ? input.version.trim() : null;
  const commit = typeof input.commit === "string" && commitPattern.test(input.commit) ? input.commit.toLowerCase() : null;
  const branch = typeof input.branch === "string" && branchPattern.test(input.branch) ? input.branch : null;
  const sourcePr =
    typeof input.sourcePr === "number" && Number.isSafeInteger(input.sourcePr) && input.sourcePr > 0
      ? input.sourcePr
      : typeof input.sourcePr === "string" && /^[1-9]\d*$/.test(input.sourcePr) && Number.isSafeInteger(Number(input.sourcePr))
        ? Number(input.sourcePr)
        : null;
  return { version, commit, branch, sourcePr };
}

export const buildMetadata = normalizeBuildMetadata(__CHANGD_BUILD_METADATA__);

export const commitUrl = (commit: string) => `https://github.com/mkaand/changd-fusion/commit/${commit}`;
export const pullRequestUrl = (number: number) => `https://github.com/mkaand/changd-fusion/pull/${number}`;
