import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { EgressPolicy, safeFetch } from "./egress.js";
import { HttpError } from "./errors.js";
import { fetchMarkdownNew, validateJinaReaderContent } from "./capture.js";
import { generateSelectedTextRule, segmentSelectedText, searchJinaLines } from "./selected-text.js";

export const jinaTextPreviewFetchOptions = Object.freeze({ jinaNoCache: true });

type TextSession = { id: string; ownerId: string; createdAt: number; expiresAt: number; lines: string[] };
export const TEXT_PREVIEW_IDLE_MS = 180_000;
export const TEXT_PREVIEW_MAX_MS = 600_000;
const MAX_SESSIONS = 8;
const sessions = new Map<string, TextSession>();
let initializing = 0;

function purge() {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
}
const cleanup = setInterval(purge, TEXT_PREVIEW_IDLE_MS);
cleanup.unref();

export async function previewJinaText(input: {
  ownerId: string;
  url?: string;
  source?: "direct" | "jina" | "markdown_new";
  markdownRender?: "auto" | "browser";
  directPreview?: () => Promise<string>;
  sessionId?: string;
  lineIndex?: number;
  selectedValue?: string;
  query?: string;
  offset?: number;
  limit?: number;
}, cfg: Config, policy = new EgressPolicy()) {
  purge();
  if (input.sessionId) {
    const session = sessions.get(input.sessionId);
    if (!session || session.ownerId !== input.ownerId) throw new HttpError(410, "Text preview expired. Refresh the preview and try again.");
    const result = input.query !== undefined || input.offset !== undefined || input.limit !== undefined
      ? searchJinaLines(session.lines, input.query, input.offset, input.limit)
      : input.lineIndex === undefined || input.selectedValue === undefined
        ? (() => { throw new HttpError(422, "Choose text from the preview."); })()
        : generateSelectedTextRule(session.lines, input.lineIndex, input.selectedValue);
    if (Date.now() >= session.expiresAt) { sessions.delete(session.id); throw new HttpError(410, "Text preview expired. Refresh the preview and try again."); }
    session.expiresAt = Math.min(session.createdAt + TEXT_PREVIEW_MAX_MS, Date.now() + TEXT_PREVIEW_IDLE_MS);
    return { session_id: session.id, expires_at: new Date(session.expiresAt).toISOString(), ...result };
  }
  if (!input.url) throw new HttpError(422, "Enter a valid URL before opening text preview.");
  await policy.target(input.url);
  if (sessions.size + initializing >= MAX_SESSIONS) throw new HttpError(429, "Text preview capacity is busy. Retry shortly.");
  initializing++;
  try {
    const content = input.source === "markdown_new"
      ? await fetchMarkdownNew({ url: input.url, markdown_render: input.markdownRender ?? "auto" }, policy, cfg.CAPTURE_TIMEOUT_MS)
      : input.source === "direct"
        ? await input.directPreview?.() ?? (() => { throw new HttpError(422, "Direct Browser preview is unavailable."); })()
        : validateJinaReaderContent((await safeFetch(`https://r.jina.ai/${input.url}`, policy, cfg.CAPTURE_TIMEOUT_MS, 2_000_000, jinaTextPreviewFetchOptions)).body);
    const lines = segmentSelectedText(content).map(segment => segment.text);
    if (!lines.length) throw new HttpError(422, "The selected source returned no selectable text.");
    const now = Date.now();
    const session: TextSession = { id: randomUUID(), ownerId: input.ownerId, createdAt: now, expiresAt: now + TEXT_PREVIEW_IDLE_MS, lines };
    sessions.set(session.id, session);
    return { session_id: session.id, expires_at: new Date(session.expiresAt).toISOString(), ...searchJinaLines(lines, input.query, input.offset, input.limit) };
  } finally { initializing--; }
}

export function clearTextPreviewSessions() { sessions.clear(); initializing = 0; }
