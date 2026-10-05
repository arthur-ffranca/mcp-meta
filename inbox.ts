import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hintForCode } from "../services/graph.js";
import { normalizePhone } from "../services/phone.js";
import type { StoredMessage } from "../services/store.js";
import { handler, iso, ok, phoneSchema, sessionWindow, type ToolContext } from "./shared.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function webhookNote(ctx: ToolContext): string | undefined {
  return ctx.cfg.webhookVerifyToken
    ? undefined
    : "Webhook is not configured on this server (WEBHOOK_VERIFY_TOKEN / WHATSAPP_APP_SECRET), so inbound messages and delivery statuses are NOT being recorded. Only messages sent through this server appear.";
}

function present(m: StoredMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: m.id,
    direction: m.direction,
    type: m.type,
    text: m.text,
    at: iso(m.timestamp),
    status: m.status,
  };
  if (m.media_id) out.media_id = m.media_id;
  if (m.mime_type) out.mime_type = m.mime_type;
  if (m.filename) out.filename = m.filename;
  if (m.context_id) out.reply_to = m.context_id;
  if (m.direction === "in") out.read = m.read === 1;
  if (m.error_code) out.error = { code: m.error_code, message: m.error_message };
  return out;
}

export function registerInboxTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "whatsapp_list_conversations",
    {
      title: "List WhatsApp conversations",
      description: `List conversations recorded by this server, most recent first, with contact name, last message, unread count and whether the 24h free-form window is still open. History starts when the server's webhook was connected; older chats are not available from the Cloud API.

Returns: { total, count, offset, conversations: [{ wa_id, name, unread, window_open, window_expires_at, last_message: { direction, type, text, at } }], has_more, next_offset, note? }`,
      inputSchema: {
        unread_only: z.boolean().default(false).describe("Only conversations with unread inbound messages"),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ unread_only, limit, offset }) => {
      const rows = ctx.store.listConversations(limit, offset, unread_only);
      const total = ctx.store.countConversations(unread_only);
      const hasMore = offset + rows.length < total;
      const data: Record<string, unknown> = {
        total,
        count: rows.length,
        offset,
        conversations: rows.map((r) => {
          const window = sessionWindow(r.last_inbound_ts);
          return {
            wa_id: r.wa_id,
            name: r.name,
            unread: Number(r.unread),
            window_open: window.open,
            window_expires_at: window.expires_at,
            last_message: r.last_message_id
              ? { direction: r.last_direction, type: r.last_type, text: r.last_text, at: iso(r.last_timestamp) }
              : null,
          };
        }),
        has_more: hasMore,
        next_offset: hasMore ? offset + rows.length : null,
      };
      const note = webhookNote(ctx);
      if (note) data.note = note;
      return ok(data);
    }),
  );

  server.registerTool(
    "whatsapp_get_conversation",
    {
      title: "Get WhatsApp conversation",
      description: `Read the message history with one contact, oldest first, including inbound messages, messages sent by this server and their delivery status. Media messages carry a media_id usable with whatsapp_get_media. Does not mark anything as read (use whatsapp_mark_as_read).

To page backwards, pass the 'at' of the oldest message returned as 'before'.

Returns: { wa_id, name, window_open, window_expires_at, count, messages: [{ id, direction: "in"|"out", type, text, at, status, media_id?, mime_type?, filename?, reply_to?, read?, error? }], has_more, note? }`,
      inputSchema: {
        phone: phoneSchema,
        limit: z.number().int().min(1).max(200).default(30).describe("Number of most recent messages to return"),
        before: z.string().datetime().optional().describe("ISO timestamp; only messages older than this are returned"),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ phone, limit, before }) => {
      const waId = ctx.store.resolveWaId(normalizePhone(phone));
      const contact = ctx.store.getContact(waId);
      const beforeTs = before ? Math.floor(Date.parse(before) / 1000) : undefined;
      // Fetch one extra row to learn whether older messages exist.
      const rows = ctx.store.getConversation(waId, limit + 1, beforeTs);
      const hasMore = rows.length > limit;
      const messages = (hasMore ? rows.slice(1) : rows).map(present);
      const window = sessionWindow(contact?.last_inbound_ts);
      const data: Record<string, unknown> = {
        wa_id: waId,
        name: contact?.name ?? null,
        window_open: window.open,
        window_expires_at: window.expires_at,
        count: messages.length,
        messages,
        has_more: hasMore,
      };
      const note = contact ? webhookNote(ctx) : `No conversation recorded with ${waId}.`;
      if (note) data.note = note;
      return ok(data);
    }),
  );

  server.registerTool(
    "whatsapp_get_message_status",
    {
      title: "Get WhatsApp message delivery status",
      description: `Check the delivery status of a message sent by this server: accepted (queued by Meta), sent, delivered, read or failed (with error code and guidance). Statuses arrive by webhook, usually within seconds of sending.

Returns: { message_id, wa_id, status, status_at, sent_at, error?: { code, message, next_step } }`,
      inputSchema: {
        message_id: z.string().min(1).describe("wamid returned by a send tool"),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ message_id }) => {
      const m = ctx.store.getMessage(message_id);
      if (!m) {
        throw new Error(`Message ${message_id} is not in the local log. Only messages sent or received through this server are tracked.`);
      }
      const data: Record<string, unknown> = {
        message_id: m.id,
        wa_id: m.wa_id,
        status: m.status,
        status_at: iso(m.status_timestamp),
        sent_at: iso(m.timestamp),
      };
      if (m.error_code) {
        data.error = { code: m.error_code, message: m.error_message, next_step: hintForCode(m.error_code) ?? null };
      }
      const note = webhookNote(ctx);
      if (note) data.note = note;
      return ok(data);
    }),
  );
}
