import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { CHARACTER_LIMIT, SESSION_WINDOW_SECONDS } from "../constants.js";
import { explainError, type GraphClient } from "../services/graph.js";
import type { Store } from "../services/store.js";

export interface ToolContext {
  cfg: Config;
  graph: GraphClient;
  store: Store;
}

export const phoneSchema = z
  .string()
  .min(8)
  .max(24)
  .describe("Recipient phone in international format with country code, e.g. 5521999998888 or +55 21 99999-8888");

export function ok(data: Record<string, unknown>, text?: string): CallToolResult {
  let body = text ?? JSON.stringify(data, null, 2);
  if (body.length > CHARACTER_LIMIT) {
    body = `${body.slice(0, CHARACTER_LIMIT)}\n\n[Truncated at ${CHARACTER_LIMIT} characters. Use a smaller limit or pagination to see the rest.]`;
  }
  return { content: [{ type: "text", text: body }], structuredContent: data };
}

/** Wraps a tool handler so every failure becomes an actionable, model-readable error. */
export function handler<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: explainError(error) }] };
    }
  };
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const iso = (ts: number | null | undefined): string | null =>
  ts ? new Date(ts * 1000).toISOString() : null;

/** State of the 24h customer-service window, as far as the local inbox knows. */
export function sessionWindow(lastInboundTs: number | null | undefined): {
  open: boolean;
  expires_at: string | null;
} {
  if (!lastInboundTs) return { open: false, expires_at: null };
  const expires = lastInboundTs + SESSION_WINDOW_SECONDS;
  return { open: expires > nowSeconds(), expires_at: iso(expires) };
}

export function requireWaba(cfg: Config): string {
  if (!cfg.wabaId) {
    throw new Error(
      "WHATSAPP_BUSINESS_ACCOUNT_ID is not configured on the server; template tools need it. Set it and redeploy.",
    );
  }
  return cfg.wabaId;
}
