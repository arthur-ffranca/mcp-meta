import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessageStatus, Store } from "./services/store.js";

/** Validates Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

interface WaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

interface WaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  context?: { id?: string };
  text?: { body?: string };
  image?: WaMedia;
  document?: WaMedia;
  audio?: WaMedia;
  video?: WaMedia;
  sticker?: WaMedia;
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  button?: { text?: string; payload?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  contacts?: Array<{ name?: { formatted_name?: string }; phones?: Array<{ phone?: string }> }>;
  reaction?: { message_id?: string; emoji?: string };
  errors?: Array<{ code?: number; title?: string }>;
}

interface WaStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
}

interface WaChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: WaMessage[];
  statuses?: WaStatus[];
}

interface WebhookPayload {
  object?: string;
  entry?: Array<{ changes?: Array<{ field?: string; value?: WaChangeValue }> }>;
}

const MEDIA_TYPES = ["image", "document", "audio", "video", "sticker"] as const;

function describe(m: WaMessage): { text: string | null; media?: WaMedia } {
  for (const t of MEDIA_TYPES) {
    if (m.type === t && m[t]) {
      const media = m[t];
      return { text: media.caption ?? media.filename ?? null, media };
    }
  }
  switch (m.type) {
    case "text":
      return { text: m.text?.body ?? null };
    case "interactive": {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      return { text: reply ? `${reply.title ?? ""} [reply id: ${reply.id ?? ""}]` : null };
    }
    case "button":
      return { text: m.button?.text ?? m.button?.payload ?? null };
    case "location": {
      const l = m.location;
      const label = [l?.name, l?.address].filter(Boolean).join(", ");
      return { text: `Location ${l?.latitude},${l?.longitude}${label ? ` (${label})` : ""}` };
    }
    case "contacts":
      return {
        text: (m.contacts ?? [])
          .map((c) => `${c.name?.formatted_name ?? "Contact"}: ${(c.phones ?? []).map((p) => p.phone).join(", ")}`)
          .join("; "),
      };
    case "reaction":
      return { text: `Reacted ${m.reaction?.emoji || "(removed)"} to ${m.reaction?.message_id ?? "a message"}` };
    default:
      return { text: m.errors?.[0]?.title ?? null };
  }
}

export interface IngestResult {
  messages: number;
  statuses: number;
}

/** Persists inbound messages and delivery statuses from a webhook notification. */
export function ingestWebhook(payload: unknown, store: Store, phoneNumberId: string): IngestResult {
  const result: IngestResult = { messages: 0, statuses: 0 };
  const body = payload as WebhookPayload;
  if (body?.object !== "whatsapp_business_account") return result;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (change.field !== "messages" || !value) continue;
      // A WABA can hold several numbers; only keep traffic for the one this server operates.
      if (value.metadata?.phone_number_id !== phoneNumberId) continue;

      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name);
      }

      for (const m of value.messages ?? []) {
        if (!m.id || !m.from) continue;
        const ts = Number.parseInt(m.timestamp, 10) || Math.floor(Date.now() / 1000);
        const { text, media } = describe(m);
        store.upsertContact(m.from, names.get(m.from), ts);
        const inserted = store.insertMessage({
          id: m.id,
          wa_id: m.from,
          direction: "in",
          type: m.type,
          text,
          media_id: media?.id ?? null,
          mime_type: media?.mime_type ?? null,
          filename: media?.filename ?? null,
          context_id: m.context?.id ?? null,
          timestamp: ts,
          status: "received",
        });
        if (inserted) result.messages += 1;
      }

      for (const s of value.statuses ?? []) {
        if (!s.id || !s.recipient_id) continue;
        const err = s.errors?.[0];
        store.updateStatus(
          s.id,
          s.recipient_id,
          s.status as MessageStatus,
          Number.parseInt(s.timestamp, 10) || Math.floor(Date.now() / 1000),
          err?.code,
          err ? [err.title, err.error_data?.details ?? err.message].filter(Boolean).join(": ") : undefined,
        );
        result.statuses += 1;
      }
    }
  }
  return result;
}
