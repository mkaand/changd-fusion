import { z } from "zod";
import { encrypt, decrypt } from "./crypto.js";
import { AttentionFailure } from "./attention.js";
export const vaultSchema = z
  .object({
    values: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/),
        z.string().min(1).max(512),
      )
      .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 20),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((v) => {
    const t = Date.parse(v.expires_at) - Date.now();
    return t > 0 && t <= 30 * 86400000;
  });
export const vaultBinding = (id: string, user: string, origin: string) =>
  JSON.stringify([id, user, origin]);
export function sealValues(
  values: Record<string, string>,
  key: string,
  id: string,
  user: string,
  origin: string,
) {
  return encrypt(values, key, vaultBinding(id, user, origin));
}
export function openValues(
  row: any,
  key: string,
  m: { id: string; user_id: string; url: string },
) {
  if (
    row.user_id !== m.user_id ||
    row.monitor_id !== m.id ||
    row.origin !== new URL(m.url).origin ||
    Date.parse(row.expires_at) <= Date.now()
  )
    throw new AttentionFailure(
      "authentication_required",
      "confirmed",
      "Private values expired or require reconfiguration.",
    );
  return decrypt(
    row.encrypted,
    key,
    vaultBinding(m.id, m.user_id, row.origin),
  ) as Record<string, string>;
}
