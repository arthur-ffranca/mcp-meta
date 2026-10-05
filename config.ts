import {
  DEFAULT_GRAPH_BASE_URL,
  DEFAULT_GRAPH_VERSION,
  MIN_MCP_TOKEN_LENGTH,
} from "./constants.js";
import { normalizePhone } from "./services/phone.js";

export interface Config {
  transport: "http" | "stdio";
  port: number;
  accessToken: string;
  phoneNumberId: string;
  /** WhatsApp Business Account ID. Required only by the template tools. */
  wabaId?: string;
  graphBaseUrl: string;
  graphVersion: string;
  /** Shared secret protecting the /mcp endpoint (HTTP transport). */
  mcpAuthToken?: string;
  webhookVerifyToken?: string;
  appSecret?: string;
  dataDir: string;
  /** When non-empty, outbound messages are restricted to these numbers. */
  allowedRecipients: Set<string>;
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function required(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function loadConfig(): Config {
  const transport = (env("TRANSPORT") ?? "http").toLowerCase();
  if (transport !== "http" && transport !== "stdio") {
    throw new Error(`TRANSPORT must be "http" or "stdio" (got "${transport}")`);
  }

  const mcpAuthToken = env("MCP_AUTH_TOKEN");
  if (transport === "http") {
    if (!mcpAuthToken) {
      throw new Error(
        "MCP_AUTH_TOKEN is required with TRANSPORT=http. Generate one with: openssl rand -hex 32",
      );
    }
    if (mcpAuthToken.length < MIN_MCP_TOKEN_LENGTH) {
      throw new Error(`MCP_AUTH_TOKEN must have at least ${MIN_MCP_TOKEN_LENGTH} characters`);
    }
  }

  const webhookVerifyToken = env("WEBHOOK_VERIFY_TOKEN");
  const appSecret = env("WHATSAPP_APP_SECRET");
  if (Boolean(webhookVerifyToken) !== Boolean(appSecret)) {
    throw new Error(
      "WEBHOOK_VERIFY_TOKEN and WHATSAPP_APP_SECRET must be set together (both are needed to accept webhooks safely)",
    );
  }

  const allowedRecipients = new Set(
    (env("WHATSAPP_ALLOWED_RECIPIENTS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizePhone),
  );

  return {
    transport,
    port: Number.parseInt(env("PORT") ?? "3000", 10),
    accessToken: required("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    wabaId: env("WHATSAPP_BUSINESS_ACCOUNT_ID"),
    graphBaseUrl: (env("GRAPH_API_BASE_URL") ?? DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, ""),
    graphVersion: env("GRAPH_API_VERSION") ?? DEFAULT_GRAPH_VERSION,
    mcpAuthToken,
    webhookVerifyToken,
    appSecret,
    dataDir: env("DATA_DIR") ?? "./data",
    allowedRecipients,
  };
}
