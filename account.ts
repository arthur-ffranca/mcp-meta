import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphApiError } from "../services/graph.js";
import { handler, ok, type ToolContext } from "./shared.js";

const PHONE_FIELDS_CORE = "id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status";
const PHONE_FIELDS_EXTRA = "status,platform_type,throughput,messaging_limit_tier";
const PROFILE_FIELDS = "about,address,description,email,profile_picture_url,websites,vertical";

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "whatsapp_get_phone_number",
    {
      title: "Get WhatsApp phone number health",
      description: `Get the status of the business phone number this server sends from: display number, verified name, quality rating (GREEN/YELLOW/RED), connection status, throughput and messaging limit tier. Use to diagnose delivery problems.

Returns: { id, display_phone_number, verified_name, quality_rating, status, name_status, code_verification_status, platform_type, throughput, messaging_limit_tier }`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler(async () => {
      const get = (fields: string): Promise<Record<string, unknown>> =>
        ctx.graph.request<Record<string, unknown>>("GET", ctx.cfg.phoneNumberId, { query: { fields } });
      try {
        return ok(await get(`${PHONE_FIELDS_CORE},${PHONE_FIELDS_EXTRA}`));
      } catch (error) {
        // Field availability varies across Graph versions; fall back to the stable core set.
        if (error instanceof GraphApiError && error.code === 100) return ok(await get(PHONE_FIELDS_CORE));
        throw error;
      }
    }),
  );

  server.registerTool(
    "whatsapp_get_business_profile",
    {
      title: "Get WhatsApp business profile",
      description: `Get the public business profile users see in WhatsApp: about, description, address, email, websites, category (vertical) and profile picture URL.

Returns: { about, address, description, email, profile_picture_url, websites, vertical }`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler(async () => {
      const res = await ctx.graph.request<{ data?: Array<Record<string, unknown>> }>(
        "GET",
        `${ctx.cfg.phoneNumberId}/whatsapp_business_profile`,
        { query: { fields: PROFILE_FIELDS } },
      );
      return ok(res.data?.[0] ?? {});
    }),
  );

  server.registerTool(
    "whatsapp_update_business_profile",
    {
      title: "Update WhatsApp business profile",
      description: `Update fields of the public business profile. Only the fields provided are changed; the change is visible to all users immediately.

Returns: { success, updated: [field names] }`,
      inputSchema: {
        about: z.string().min(1).max(139).optional().describe("Short 'about' line (max 139 chars)"),
        description: z.string().max(512).optional(),
        address: z.string().max(256).optional(),
        email: z.string().email().max(128).optional(),
        websites: z.array(z.string().url().max(256)).max(2).optional().describe("Up to 2 website URLs"),
        vertical: z
          .enum([
            "OTHER", "AUTO", "BEAUTY", "APPAREL", "EDU", "ENTERTAIN", "EVENT_PLAN", "FINANCE", "GROCERY",
            "GOVT", "HOTEL", "HEALTH", "NONPROFIT", "PROF_SERVICES", "RETAIL", "TRAVEL", "RESTAURANT",
          ])
          .optional()
          .describe("Business category"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler(async (fields) => {
      const updates = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (Object.keys(updates).length === 0) throw new Error("Provide at least one field to update.");
      const res = await ctx.graph.request<{ success?: boolean }>(
        "POST",
        `${ctx.cfg.phoneNumberId}/whatsapp_business_profile`,
        { body: { messaging_product: "whatsapp", ...updates } },
      );
      return ok({ success: res.success ?? true, updated: Object.keys(updates) });
    }),
  );
}
