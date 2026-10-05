#!/usr/bin/env node
/**
 * MCP server for the WhatsApp Cloud API (Meta).
 *
 * Exposes messaging, template, media and account tools, plus a webhook receiver that
 * persists inbound messages and delivery statuses so conversations can be read back.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { loadConfig, type Config } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { GraphClient } from "./services/graph.js";
import { Store } from "./services/store.js";
import { registerAccountTools } from "./tools/account.js";
import { registerInboxTools } from "./tools/inbox.js";
import { registerMediaTools } from "./tools/media.js";
import { registerMessageTools } from "./tools/messages.js";
import type { ToolContext } from "./tools/shared.js";
import { registerTemplateTools } from "./tools/templates.js";
import { ingestWebhook, verifySignature } from "./webhook.js";

type RawRequest = Request & { rawBody?: Buffer };

function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for one WhatsApp Business number. Sends reach real people: free-form messages only work within 24h of the user's last message; otherwise use an approved template (whatsapp_list_templates, then whatsapp_send_template). A send result of 'accepted' is not delivery; confirm with whatsapp_get_message_status. Read incoming messages with whatsapp_list_conversations and whatsapp_get_conversation.",
    },
  );
  registerMessageTools(server, ctx);
  registerInboxTools(server, ctx);
  registerTemplateTools(server, ctx);
  registerMediaTools(server, ctx);
  registerAccountTools(server, ctx);
  return server;
}

/** Constant-time comparison that does not leak the secret's length. */
function secretsMatch(candidate: string, secret: string): boolean {
  const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(candidate), digest(secret));
}

function isAuthorized(req: Request, cfg: Config): boolean {
  const secret = cfg.mcpAuthToken;
  if (!secret) return false;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ") && secretsMatch(header.slice(7).trim(), secret)) return true;
  const pathToken = req.params.token;
  return typeof pathToken === "string" && secretsMatch(pathToken, secret);
}

function runHttp(cfg: Config, ctx: ToolContext): void {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(
    express.json({
      limit: "25mb",
      verify: (req, _res, buf) => {
        (req as RawRequest).rawBody = buf;
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION, webhook: Boolean(cfg.webhookVerifyToken) });
  });

  // Webhook verification handshake (Meta app dashboard > WhatsApp > Configuration).
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (
      cfg.webhookVerifyToken &&
      mode === "subscribe" &&
      typeof token === "string" &&
      secretsMatch(token, cfg.webhookVerifyToken)
    ) {
      res.status(200).type("text/plain").send(String(challenge ?? ""));
      return;
    }
    res.sendStatus(403);
  });

  app.post("/webhook", (req: RawRequest, res) => {
    if (!cfg.appSecret) {
      res.sendStatus(503);
      return;
    }
    if (!req.rawBody || !verifySignature(req.rawBody, req.header("x-hub-signature-256"), cfg.appSecret)) {
      res.sendStatus(401);
      return;
    }
    try {
      const r = ingestWebhook(req.body, ctx.store, cfg.phoneNumberId);
      if (r.messages || r.statuses) console.error(`[webhook] stored ${r.messages} message(s), ${r.statuses} status(es)`);
    } catch (error) {
      // Always acknowledge: Meta retries non-200 responses for days and may disable the webhook.
      console.error("[webhook] failed to process notification:", error);
    }
    res.sendStatus(200);
  });

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    if (!isAuthorized(req, cfg)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    // Stateless mode: a fresh server and transport per request, so instances scale horizontally.
    const server = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[mcp] request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This server is stateless; use POST." },
      id: null,
    });
  };

  for (const path of ["/mcp", "/mcp/:token"]) {
    app.post(path, handleMcp);
    app.get(path, methodNotAllowed);
    app.delete(path, methodNotAllowed);
  }

  const httpServer = app.listen(cfg.port, () => {
    console.error(`${SERVER_NAME} ${SERVER_VERSION} listening on :${cfg.port} (MCP at /mcp, webhook ${cfg.webhookVerifyToken ? "enabled" : "disabled"} at /webhook)`);
  });

  const shutdown = (): void => {
    httpServer.close(() => {
      ctx.store.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function runStdio(ctx: ToolContext): Promise<void> {
  await createServer(ctx).connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} running on stdio`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ctx: ToolContext = { cfg, graph: new GraphClient(cfg), store: new Store(cfg.dataDir) };
  if (cfg.transport === "stdio") await runStdio(ctx);
  else runHttp(cfg, ctx);
}

main().catch((error: unknown) => {
  console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
