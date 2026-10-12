import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { EgressPolicy, safeFetch } from "./egress.js";
import { HttpError } from "./errors.js";
import { validateJinaReaderContent } from "./capture.js";
import { generateSelectedTextRule, readableJinaPreview } from "./selected-text.js";

type TextSession = { id: string; ownerId: string; expiresAt: number; lines: string[] };
const TTL_MS = 90_000;
const MAX_SESSIONS = 8;
const sessions = new Map<string, TextSession>();
let initializing = 0;

function purge() {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
}
const cleanup = setInterval(purge, TTL_MS);
cleanup.unref();

export async function previewJinaText(input: {
  ownerId: string;
  url?: string;
  sessionId?: string;
  lineIndex?: number;
  selectedValue?: string;
}, cfg: Config, policy = new EgressPolicy()) {
  purge();
  if (input.sessionId) {
    const session = sessions.get(input.sessionId);
    if (!session || session.ownerId !== input.ownerId) throw new HttpError(410, "Text preview expired. Refresh the preview and try again.");
    if (input.lineIndex === undefined || input.selectedValue === undefined) throw new HttpError(422, "Choose text from the preview.");
    session.expiresAt = Date.now() + TTL_MS;
    return { session_id: session.id, ...generateSelectedTextRule(session.lines, input.lineIndex, input.selectedValue) };
  }
  if (!input.url) throw new HttpError(422, "Enter a valid URL before opening text preview.");
  await policy.target(input.url);
  if (sessions.size + initializing >= MAX_SESSIONS) throw new HttpError(429, "Text preview capacity is busy. Retry shortly.");
  initializing++;
  try {
    const response = await safeFetch(`https://r.jina.ai/${input.url}`, policy, cfg.CAPTURE_TIMEOUT_MS);
    const readable = readableJinaPreview(validateJinaReaderContent(response.body));
    const lines = readable.lines;
    if (!lines.length) throw new HttpError(422, "Reader returned no selectable text.");
    const session: TextSession = { id: randomUUID(), ownerId: input.ownerId, expiresAt: Date.now() + TTL_MS, lines };
    sessions.set(session.id, session);
    return { session_id: session.id, lines, truncated: readable.truncated, total_line_count: readable.totalLines };
  } finally { initializing--; }
}

export function clearTextPreviewSessions() { sessions.clear(); initializing = 0; }
