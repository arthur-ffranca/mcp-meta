import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handler, ok, requireWaba, type ToolContext } from "./shared.js";

interface TemplateComponent {
  type?: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type?: string; text?: string; url?: string }>;
}

interface Template {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  components?: TemplateComponent[];
  rejected_reason?: string;
  quality_score?: { score?: string };
}

interface TemplateList {
  data?: Template[];
  paging?: { cursors?: { after?: string }; next?: string };
}

const countVariables = (text: string | undefined): number =>
  new Set(text?.match(/\{\{\s*[\w]+\s*\}\}/g) ?? []).size;

export function registerTemplateTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "whatsapp_list_templates",
    {
      title: "List WhatsApp message templates",
      description: `List the message templates of the WhatsApp Business Account, with approval status, category, language, body text and how many variables each part expects. Use before whatsapp_send_template.

Returns: { count, templates: [{ id, name, status, category, language, header, body, body_variables, footer, buttons, quality, rejected_reason }], has_more, next_cursor }`,
      inputSchema: {
        status: z
          .enum(["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"])
          .optional()
          .describe("Filter by review status"),
        name: z.string().optional().describe("Filter by template name (partial match)"),
        limit: z.number().int().min(1).max(100).default(25),
        after: z.string().optional().describe("Pagination cursor from a previous call's next_cursor"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler(async ({ status, name, limit, after }) => {
      const res = await ctx.graph.request<TemplateList>("GET", `${requireWaba(ctx.cfg)}/message_templates`, {
        query: {
          fields: "id,name,status,category,language,components,rejected_reason,quality_score",
          status,
          name,
          limit,
          after,
        },
      });
      const templates = (res.data ?? []).map((t) => {
        const part = (type: string): TemplateComponent | undefined =>
          t.components?.find((c) => c.type?.toUpperCase() === type);
        const header = part("HEADER");
        const body = part("BODY");
        return {
          id: t.id,
          name: t.name,
          status: t.status,
          category: t.category,
          language: t.language,
          header: header ? { format: header.format ?? "TEXT", text: header.text ?? null, variables: countVariables(header.text) } : null,
          body: body?.text ?? null,
          body_variables: countVariables(body?.text),
          footer: part("FOOTER")?.text ?? null,
          buttons: (part("BUTTONS")?.buttons ?? []).map((b, index) => ({ index, type: b.type, text: b.text, url: b.url })),
          quality: t.quality_score?.score ?? null,
          rejected_reason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
        };
      });
      const hasMore = Boolean(res.paging?.next);
      return ok({
        count: templates.length,
        templates,
        has_more: hasMore,
        next_cursor: hasMore ? (res.paging?.cursors?.after ?? null) : null,
      });
    }),
  );

  server.registerTool(
    "whatsapp_create_template",
    {
      title: "Create WhatsApp message template",
      description: `Submit a new message template for Meta's review. Approval usually takes minutes but can take up to 24h; the template can only be sent once its status is APPROVED (check with whatsapp_list_templates).

'components' uses the Cloud API format. Example for a body with two variables:
[{ "type": "BODY", "text": "Olá {{1}}, sua sessão é {{2}}.", "example": { "body_text": [["Ana", "amanhã às 10h"]] } }]
Variables require an 'example'. Categories: UTILITY (transactional updates), MARKETING (promotions, invitations), AUTHENTICATION (one-time codes). Meta may reclassify the category.

Returns: { id, status, category }`,
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z0-9_]{1,512}$/, "Use only lowercase letters, digits and underscores")
          .describe("Template name, e.g. 'lembrete_sessao'"),
        category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]),
        language: z.string().min(2).max(10).default("pt_BR"),
        components: z.array(z.record(z.unknown())).min(1).describe("Template components (HEADER, BODY, FOOTER, BUTTONS)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(async ({ name, category, language, components }) => {
      const res = await ctx.graph.request<{ id: string; status: string; category: string }>(
        "POST",
        `${requireWaba(ctx.cfg)}/message_templates`,
        { body: { name, category, language, components } },
      );
      return ok({ id: res.id, status: res.status, category: res.category });
    }),
  );

  server.registerTool(
    "whatsapp_delete_template",
    {
      title: "Delete WhatsApp message template",
      description: `Permanently delete a message template by name, in ALL its languages. Irreversible: the name cannot be reused for 30 days and messages already sent are unaffected. Confirm with the user before calling.

Returns: { success, name }`,
      inputSchema: {
        name: z.string().min(1).max(512).describe("Exact template name"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handler(async ({ name }) => {
      const res = await ctx.graph.request<{ success?: boolean }>(
        "DELETE",
        `${requireWaba(ctx.cfg)}/message_templates`,
        { query: { name } },
      );
      return ok({ success: res.success ?? true, name });
    }),
  );
}
