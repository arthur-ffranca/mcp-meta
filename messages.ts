import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { normalizePhone, phoneVariants } from "../services/phone.js";
import { handler, nowSeconds, ok, phoneSchema, sessionWindow, type ToolContext } from "./shared.js";

interface SendResponse {
  contacts?: Array<{ input?: string; wa_id?: string }>;
  messages?: Array<{ id?: string; message_status?: string }>;
}

interface SendRecord {
  type: string;
  text: string | null;
  media_id?: string | null;
  filename?: string | null;
  context_id?: string | null;
  /** Templates may be sent outside the 24h window; everything else may not. */
  freeForm: boolean;
}

const SEND_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const replyTo = z
  .string()
  .optional()
  .describe("Optional wamid of a message to quote, making this a contextual reply");

async function send(
  ctx: ToolContext,
  to: string,
  payload: Record<string, unknown>,
  record: SendRecord,
): Promise<CallToolResult> {
  const digits = normalizePhone(to);
  const { allowedRecipients } = ctx.cfg;
  if (allowedRecipients.size > 0 && !phoneVariants(digits).some((v) => allowedRecipients.has(v))) {
    throw new Error(
      `Recipient ${digits} is not in WHATSAPP_ALLOWED_RECIPIENTS. This server is restricted to an allowlist; ask the operator to add the number.`,
    );
  }

  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: digits,
    ...payload,
  };
  if (record.context_id) body.context = { message_id: record.context_id };

  const res = await ctx.graph.request<SendResponse>("POST", `${ctx.cfg.phoneNumberId}/messages`, { body });
  const messageId = res.messages?.[0]?.id;
  if (!messageId) throw new Error("The Cloud API accepted the request but returned no message id.");
  const waId = res.contacts?.[0]?.wa_id ?? digits;

  ctx.store.upsertContact(waId);
  ctx.store.insertMessage({
    id: messageId,
    wa_id: waId,
    direction: "out",
    type: record.type,
    text: record.text,
    media_id: record.media_id ?? null,
    mime_type: null,
    filename: record.filename ?? null,
    context_id: record.context_id ?? null,
    timestamp: nowSeconds(),
    status: "accepted",
  });

  const result: Record<string, unknown> = { message_id: messageId, wa_id: waId, status: "accepted" };
  if (record.freeForm && ctx.cfg.webhookVerifyToken) {
    const window = sessionWindow(ctx.store.getContact(waId)?.last_inbound_ts);
    if (!window.open) {
      result.warning =
        "No inbound message from this number in the last 24h is recorded locally. 'accepted' is not 'delivered': if the 24h window is closed the message fails asynchronously with error 131047. Check whatsapp_get_message_status in a few seconds, or use whatsapp_send_template.";
    }
  }
  return ok(result);
}

export function registerMessageTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "whatsapp_send_text",
    {
      title: "Send WhatsApp text message",
      description: `Send a free-form text message to a WhatsApp user. This delivers a real message to a real person.

Only deliverable within 24h of the user's last inbound message (customer-service window). Outside it, use whatsapp_send_template. The result status "accepted" means queued by Meta, not delivered; use whatsapp_get_message_status to confirm delivery.

Returns: { message_id, wa_id, status: "accepted", warning? }`,
      inputSchema: {
        to: phoneSchema,
        body: z.string().min(1).max(4096).describe("Message text (max 4096 chars). Supports WhatsApp formatting: *bold*, _italic_, ~strike~"),
        preview_url: z.boolean().default(false).describe("Render a link preview for the first URL in the body"),
        reply_to_message_id: replyTo,
      },
      annotations: SEND_ANNOTATIONS,
    },
    handler(async ({ to, body, preview_url, reply_to_message_id }) =>
      send(
        ctx,
        to,
        { type: "text", text: { body, preview_url } },
        { type: "text", text: body, context_id: reply_to_message_id, freeForm: true },
      ),
    ),
  );

  server.registerTool(
    "whatsapp_send_template",
    {
      title: "Send WhatsApp template message",
      description: `Send a pre-approved template message. This is the only way to start a conversation or to message a user more than 24h after their last message. Template messages are billed by Meta per delivery.

Call whatsapp_list_templates first to get the exact name, language and number of variables. Pass variables with the convenience fields below, or pass raw 'components' (Cloud API format) for anything more complex; when 'components' is given the convenience fields are ignored.

Returns: { message_id, wa_id, status: "accepted" }`,
      inputSchema: {
        to: phoneSchema,
        template_name: z.string().min(1).max(512).describe("Template name, e.g. 'convite_mediacao'"),
        language: z.string().min(2).max(10).default("pt_BR").describe("Template language code, e.g. pt_BR, en_US"),
        body_parameters: z
          .array(z.string().min(1).max(1024))
          .max(20)
          .optional()
          .describe("Values for the body variables {{1}}, {{2}}... in order"),
        header_text_parameter: z.string().max(60).optional().describe("Value for a text header variable {{1}}"),
        header_media: z
          .object({
            type: z.enum(["image", "document", "video"]),
            link: z.string().url().optional().describe("Public HTTPS URL of the media"),
            id: z.string().optional().describe("Media id from whatsapp_upload_media"),
            filename: z.string().optional().describe("File name shown for documents"),
          })
          .optional()
          .describe("Media for templates whose header is an image, document or video. Give either link or id"),
        button_parameters: z
          .array(
            z.object({
              index: z.number().int().min(0).max(9).describe("Zero-based position of the button in the template"),
              sub_type: z.enum(["url", "quick_reply"]),
              value: z.string().min(1).describe("URL suffix for 'url' buttons, or payload for 'quick_reply' buttons"),
            }),
          )
          .max(10)
          .optional(),
        components: z
          .array(z.record(z.unknown()))
          .optional()
          .describe("Raw Cloud API template components array; overrides the convenience fields"),
      },
      annotations: SEND_ANNOTATIONS,
    },
    handler(async (a) => {
      let components = a.components;
      if (!components) {
        components = [];
        if (a.header_media) {
          const { type, link, id, filename } = a.header_media;
          if (Boolean(link) === Boolean(id)) throw new Error("header_media needs exactly one of 'link' or 'id'.");
          const media: Record<string, unknown> = link ? { link } : { id };
          if (type === "document" && filename) media.filename = filename;
          components.push({ type: "header", parameters: [{ type, [type]: media }] });
        } else if (a.header_text_parameter) {
          components.push({ type: "header", parameters: [{ type: "text", text: a.header_text_parameter }] });
        }
        if (a.body_parameters?.length) {
          components.push({
            type: "body",
            parameters: a.body_parameters.map((text) => ({ type: "text", text })),
          });
        }
        for (const b of a.button_parameters ?? []) {
          components.push({
            type: "button",
            sub_type: b.sub_type,
            index: String(b.index),
            parameters: [b.sub_type === "url" ? { type: "text", text: b.value } : { type: "payload", payload: b.value }],
          });
        }
      }
      const template: Record<string, unknown> = { name: a.template_name, language: { code: a.language } };
      if (components.length) template.components = components;
      const summary = `[template ${a.template_name}/${a.language}]${a.body_parameters?.length ? ` ${a.body_parameters.join(" | ")}` : ""}`;
      return send(ctx, a.to, { type: "template", template }, { type: "template", text: summary, freeForm: false });
    }),
  );

  server.registerTool(
    "whatsapp_send_media",
    {
      title: "Send WhatsApp media message",
      description: `Send an image, document, audio, video or sticker to a WhatsApp user. Subject to the 24h window like whatsapp_send_text.

Provide exactly one of 'media_id' (from whatsapp_upload_media) or 'link' (public HTTPS URL that WhatsApp downloads). Captions work for image, video and document only. Limits: image 5MB (JPEG/PNG), document 100MB, video 16MB (MP4/3GP), audio 16MB.

Returns: { message_id, wa_id, status: "accepted", warning? }`,
      inputSchema: {
        to: phoneSchema,
        type: z.enum(["image", "document", "audio", "video", "sticker"]),
        media_id: z.string().optional().describe("Media id returned by whatsapp_upload_media"),
        link: z.string().url().optional().describe("Public HTTPS URL of the file"),
        caption: z.string().max(1024).optional().describe("Caption (image, video, document)"),
        filename: z.string().max(240).optional().describe("File name shown to the user (document only), e.g. 'acordo.pdf'"),
        reply_to_message_id: replyTo,
      },
      annotations: SEND_ANNOTATIONS,
    },
    handler(async ({ to, type, media_id, link, caption, filename, reply_to_message_id }) => {
      if (Boolean(media_id) === Boolean(link)) throw new Error("Provide exactly one of 'media_id' or 'link'.");
      const media: Record<string, unknown> = media_id ? { id: media_id } : { link };
      if (caption) {
        if (type === "audio" || type === "sticker") throw new Error(`'caption' is not supported for ${type} messages.`);
        media.caption = caption;
      }
      if (filename && type === "document") media.filename = filename;
      return send(
        ctx,
        to,
        { type, [type]: media },
        {
          type,
          text: caption ?? filename ?? link ?? null,
          media_id,
          filename,
          context_id: reply_to_message_id,
          freeForm: true,
        },
      );
    }),
  );

  server.registerTool(
    "whatsapp_send_buttons",
    {
      title: "Send WhatsApp reply buttons",
      description: `Send an interactive message with up to 3 quick-reply buttons. The user's choice arrives in the inbox as an 'interactive' message carrying the button id. Subject to the 24h window.

Returns: { message_id, wa_id, status: "accepted", warning? }`,
      inputSchema: {
        to: phoneSchema,
        body: z.string().min(1).max(1024).describe("Main message text"),
        buttons: z
          .array(
            z.object({
              id: z.string().min(1).max(256).describe("Identifier returned when the user taps the button"),
              title: z.string().min(1).max(20).describe("Button label (max 20 chars)"),
            }),
          )
          .min(1)
          .max(3),
        header: z.string().max(60).optional().describe("Optional text header"),
        footer: z.string().max(60).optional().describe("Optional footer text"),
        reply_to_message_id: replyTo,
      },
      annotations: SEND_ANNOTATIONS,
    },
    handler(async ({ to, body, buttons, header, footer, reply_to_message_id }) => {
      const interactive: Record<string, unknown> = {
        type: "button",
        body: { text: body },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: b })) },
      };
      if (header) interactive.header = { type: "text", text: header };
      if (footer) interactive.footer = { text: footer };
      return send(
        ctx,
        to,
        { type: "interactive", interactive },
        {
          type: "interactive",
          text: `${body} [buttons: ${buttons.map((b) => b.title).join(" | ")}]`,
          context_id: reply_to_message_id,
          freeForm: true,
        },
      );
    }),
  );

  server.registerTool(
    "whatsapp_send_list",
    {
      title: "Send WhatsApp list menu",
      description: `Send an interactive list menu (up to 10 rows across all sections). Use it when there are more than 3 options. The user's choice arrives in the inbox as an 'interactive' message carrying the row id. Subject to the 24h window.

Returns: { message_id, wa_id, status: "accepted", warning? }`,
      inputSchema: {
        to: phoneSchema,
        body: z.string().min(1).max(4096).describe("Main message text"),
        button_text: z.string().min(1).max(20).describe("Label of the button that opens the list (max 20 chars)"),
        sections: z
          .array(
            z.object({
              title: z.string().max(24).optional().describe("Section title (required when there are 2+ sections)"),
              rows: z
                .array(
                  z.object({
                    id: z.string().min(1).max(200),
                    title: z.string().min(1).max(24),
                    description: z.string().max(72).optional(),
                  }),
                )
                .min(1)
                .max(10),
            }),
          )
          .min(1)
          .max(10),
        header: z.string().max(60).optional(),
        footer: z.string().max(60).optional(),
        reply_to_message_id: replyTo,
      },
      annotations: SEND_ANNOTATIONS,
    },
    handler(async ({ to, body, button_text, sections, header, footer, reply_to_message_id }) => {
      const rows = sections.reduce((n, s) => n + s.rows.length, 0);
      if (rows > 10) throw new Error(`A list supports at most 10 rows in total (got ${rows}).`);
      const interactive: Record<string, unknown> = {
        type: "list",
        body: { text: body },
        action: { button: button_text, sections },
      };
      if (header) interactive.header = { type: "text", text: header };
      if (footer) interactive.footer = { text: footer };
      return send(
        ctx,
        to,
        { type: "interactive", interactive },
        {
          type: "interactive",
          text: `${body} [list: ${sections.flatMap((s) => s.rows.map((r) => r.title)).join(" | ")}]`,
          context_id: reply_to_message_id,
          freeForm: true,
        },
      );
    }),
  );

  server.registerTool(
    "whatsapp_mark_as_read",
    {
      title: "Mark WhatsApp message as read",
      description: `Mark an inbound message (and all earlier ones in that chat) as read, showing blue ticks to the user. Optionally shows a typing indicator, which lasts until the next reply or 25 seconds.

Returns: { success, message_id }`,
      inputSchema: {
        message_id: z.string().min(1).describe("wamid of the inbound message, from whatsapp_get_conversation"),
        show_typing: z.boolean().default(false).describe("Also display the 'typing...' indicator"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler(async ({ message_id, show_typing }) => {
      const body: Record<string, unknown> = { messaging_product: "whatsapp", status: "read", message_id };
      if (show_typing) body.typing_indicator = { type: "text" };
      await ctx.graph.request("POST", `${ctx.cfg.phoneNumberId}/messages`, { body });
      ctx.store.markReadUpTo(message_id);
      return ok({ success: true, message_id });
    }),
  );
}
