import { EgressPolicy, safeFileHeaders, type FileHeaders } from "./egress.js";
import { HttpError } from "./errors.js";

export type FileMetadata = {
  etag: string | null;
  last_modified: string | null;
  size: number | null;
  status: number;
};

export function parseFileMetadata(value: string | null | undefined): FileMetadata | null {
  if (!value) return null;
  try {
    const data = JSON.parse(value);
    if (typeof data.status !== "number" || ![data.etag, data.last_modified, data.size].some((v) => v !== null && v !== undefined)) return null;
    return data;
  } catch { return null; }
}

function field(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function metadata(response: FileHeaders, range: boolean): FileMetadata {
  const contentRange = field(response.headers["content-range"]);
  const total = range && response.status === 206 ? /^bytes\s+\d+-\d+\/(\d+)$/i.exec(contentRange ?? "")?.[1] : undefined;
  const length = range && response.status === 206 ? total : field(response.headers["content-length"]);
  const size = length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null;
  return {
    etag: field(response.headers.etag),
    last_modified: field(response.headers["last-modified"]),
    size,
    status: response.status,
  };
}
function hasMetadata(m: FileMetadata): boolean {
  return m.etag !== null || m.last_modified !== null || m.size !== null;
}
export async function fetchFileMetadata(input: string, policy: EgressPolicy, previous?: FileMetadata | null, timeout = 30000): Promise<FileMetadata> {
  const deadline = Date.now() + timeout;
  const conditional = previous ? { etag: previous.etag ?? undefined, lastModified: previous.last_modified ?? undefined } : {};
  const head = await safeFileHeaders(input, policy, "HEAD", conditional, Math.max(1, deadline - Date.now()));
  if (head.status === 304) {
    if (!previous) throw new HttpError(422, "File returned 304 without a metadata baseline");
    return previous;
  }
  if (head.status === 200) {
    const found = metadata(head, false);
    if (found.size !== null) return found;
  } else if (head.status !== 405 && head.status !== 501) {
    throw new HttpError(422, `File HEAD returned HTTP ${head.status}`);
  }
  if (Date.now() >= deadline) throw Error("Capture timed out");
  const get = await safeFileHeaders(input, policy, "GET", conditional, deadline - Date.now());
  if (get.status === 304) {
    if (!previous) throw new HttpError(422, "File returned 304 without a metadata baseline");
    return previous;
  }
  if (get.status !== 200 && get.status !== 206) throw new HttpError(422, `File Range request returned HTTP ${get.status}`);
  const found = metadata(get, true);
  if (head.status === 200) {
    const headFound = metadata(head, false);
    found.etag ??= headFound.etag;
    found.last_modified ??= headFound.last_modified;
    found.status = head.status;
  }
  if (!hasMetadata(found)) throw new HttpError(422, "File metadata unavailable: ETag, Last-Modified and size are missing");
  return found;
}

export function serializeFileMetadata(value: FileMetadata): string {
  return JSON.stringify(value, null, 2);
}
