#!/usr/bin/env node
/**
 * End-to-end smoke test. Starts a fake Graph API, boots the built server against it,
 * then exercises auth, the MCP tools and the webhook. No real WhatsApp traffic is sent.
 *
 *   npm run build && npm run smoke
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GRAPH_PORT = 4801;
const MCP_PORT = 4802;
const TOKEN = "smoke-test-token-0123456789abcdef";
const APP_SECRET = "smoke-app-secret";
const VERIFY = "smoke-verify-token";
const PHONE_ID = "100000000000001";
const WABA_ID = "200000000000002";
const USER = "552199998888"; // wa_id without the 9th digit, as WhatsApp often reports for Brazil
const BASE = `http://127.0.0.1:${MCP_PORT}`;

const graphCalls = [];
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const graph = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, `http://127.0.0.1:${GRAPH_PORT}`);
  const isJson = (req.headers["content-type"] ?? "").includes("application/json");
  const body = isJson && raw.length ? JSON.parse(raw.toString()) : undefined;
  graphCalls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });

  const json = (status, data) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const p = url.pathname.replace(/^\/v[\d.]+/, "");

  if (p === "/download/media-in-1") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(PNG);
  }
  if (req.method === "POST" && p === `/${PHONE_ID}/messages`) {
    if (body.status === "read") return json(200, { success: true });
    if (body.to === "5500000000000") {
      return json(400, { error: { message: "(#131030) Recipient phone number not in allowed list", code: 131030, fbtrace_id: "T1" } });
    }
    return json(200, {
      messaging_product: "whatsapp",
      contacts: [{ input: body.to, wa_id: USER }],
      messages: [{ id: `wamid.OUT${graphCalls.length}` }],
    });
  }
  if (req.method === "GET" && p === `/${WABA_ID}/message_templates`) {
    return json(200, {
      data: [
        {
          id: "900",
          name: "convite_mediacao",
          status: "APPROVED",
          category: "UTILITY",
          language: "pt_BR",
          components: [
            { type: "BODY", text: "Olá {{1}}, você foi convidado para uma sessão em {{2}}." },
            { type: "BUTTONS", buttons: [{ type: "URL", text: "Abrir", url: "https://example.com/{{1}}" }] },
          ],
        },
      ],
      paging: { cursors: { after: "CUR" } },
    });
  }
  if (req.method === "POST" && p === `/${PHONE_ID}/media`) return json(200, { id: "media-up-1" });
  if (req.method === "GET" && p === "/media-in-1") {
    return json(200, { id: "media-in-1", mime_type: "image/png", file_size: PNG.length, sha256: "x", url: `http://127.0.0.1:${GRAPH_PORT}/download/media-in-1` });
  }
  if (req.method === "GET" && p === `/${PHONE_ID}`) {
    if (url.searchParams.get("fields").includes("messaging_limit_tier")) {
      return json(400, { error: { message: "(#100) Tried accessing nonexisting field", code: 100 } });
    }
    return json(200, { id: PHONE_ID, display_phone_number: "+55 21 4000-0000", verified_name: "Zellu", quality_rating: "GREEN" });
  }
  if (req.method === "GET" && p === `/${PHONE_ID}/whatsapp_business_profile`) {
    return json(200, { data: [{ about: "Resolução de conflitos", vertical: "PROF_SERVICES" }] });
  }
  json(404, { error: { message: "Unknown path", code: 100 } });
});

const dataDir = mkdtempSync(join(tmpdir(), "wa-mcp-smoke-"));
let child;
let failed = false;

const step = (name) => console.log(`  ok  ${name}`);

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

async function postWebhook(payload, secret = APP_SECRET) {
  const raw = JSON.stringify(payload);
  return fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
    },
    body: raw,
  });
}

const envelope = (value) => ({
  object: "whatsapp_business_account",
  entry: [{ id: WABA_ID, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: PHONE_ID }, ...value } }] }],
});

async function main() {
  await new Promise((r) => graph.listen(GRAPH_PORT, "127.0.0.1", r));
  child = spawn(process.execPath, ["dist/index.js"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      TRANSPORT: "http",
      PORT: String(MCP_PORT),
      DATA_DIR: dataDir,
      MCP_AUTH_TOKEN: TOKEN,
      WHATSAPP_ACCESS_TOKEN: "graph-token",
      WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
      WHATSAPP_BUSINESS_ACCOUNT_ID: WABA_ID,
      WHATSAPP_APP_SECRET: APP_SECRET,
      WEBHOOK_VERIFY_TOKEN: VERIFY,
      GRAPH_API_BASE_URL: `http://127.0.0.1:${GRAPH_PORT}`,
    },
  });
  await waitForHealth();

  // --- Auth -----------------------------------------------------------------
  const init = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  assert.equal((await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(init) })).status, 401);
  assert.equal((await fetch(`${BASE}/mcp/wrong-token`, { method: "POST", headers, body: JSON.stringify(init) })).status, 401);
  assert.equal((await fetch(`${BASE}/mcp/${TOKEN}`, { method: "POST", headers, body: JSON.stringify(init) })).status, 200);
  assert.equal((await fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
  step("auth: rejects missing/wrong token, accepts header and path token");

  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, data: r.structuredContent, text: r.content?.[0]?.text };
  };

  const { tools } = await client.listTools();
  assert.equal(tools.length, 17);
  for (const t of tools) {
    assert.ok(t.name.startsWith("whatsapp_") && t.description && t.annotations, `tool ${t.name} incomplete`);
  }
  step(`tools/list: ${tools.length} tools, all with description and annotations`);

  // --- Webhook --------------------------------------------------------------
  const verify = await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`);
  assert.equal(await verify.text(), "42");
  assert.equal((await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`)).status, 403);

  const now = Math.floor(Date.now() / 1000);
  const inbound = envelope({
    contacts: [{ wa_id: USER, profile: { name: "Ana Souza" } }],
    messages: [
      { id: "wamid.IN1", from: USER, timestamp: String(now - 60), type: "text", text: { body: "Olá, preciso de ajuda com um acordo" } },
      { id: "wamid.IN2", from: USER, timestamp: String(now - 30), type: "image", image: { id: "media-in-1", mime_type: "image/png", caption: "Foto do contrato" } },
    ],
  });
  assert.equal((await postWebhook(inbound, "wrong-secret")).status, 401);
  assert.equal((await postWebhook(inbound)).status, 200);
  assert.equal((await postWebhook(inbound)).status, 200); // duplicate delivery must be idempotent
  const other = envelope({ messages: [{ id: "wamid.OTHER", from: "5511911112222", timestamp: String(now), type: "text", text: { body: "x" } }] });
  other.entry[0].changes[0].value.metadata.phone_number_id = "999";
  assert.equal((await postWebhook(other)).status, 200);
  step("webhook: handshake, signature check, idempotent ingest, ignores other numbers");

  // --- Inbox ----------------------------------------------------------------
  let r = await call("whatsapp_list_conversations");
  assert.equal(r.data.total, 1);
  assert.deepEqual(
    { name: r.data.conversations[0].name, unread: r.data.conversations[0].unread, open: r.data.conversations[0].window_open },
    { name: "Ana Souza", unread: 2, open: true },
  );

  // Looked up with the 9th digit; must resolve to the stored wa_id without it.
  r = await call("whatsapp_get_conversation", { phone: "+55 (21) 99999-8888" });
  assert.equal(r.data.wa_id, USER);
  assert.equal(r.data.count, 2);
  assert.equal(r.data.messages[1].media_id, "media-in-1");
  step("inbox: lists conversation, resolves Brazilian 9th-digit variant");

  // --- Sending --------------------------------------------------------------
  r = await call("whatsapp_send_text", { to: "+55 21 99999-8888", body: "Claro, vamos lá.", reply_to_message_id: "wamid.IN1" });
  assert.ok(!r.isError, r.text);
  assert.equal(r.data.warning, undefined, "window is open, so no warning expected");
  const textId = r.data.message_id;
  let sent = graphCalls.at(-1);
  assert.equal(sent.auth, "Bearer graph-token");
  assert.deepEqual(sent.body, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "5521999998888",
    type: "text",
    text: { body: "Claro, vamos lá.", preview_url: false },
    context: { message_id: "wamid.IN1" },
  });

  r = await call("whatsapp_send_template", {
    to: "5521999998888",
    template_name: "convite_mediacao",
    body_parameters: ["Ana", "05/10 às 14h"],
    button_parameters: [{ index: 0, sub_type: "url", value: "abc123" }],
  });
  assert.ok(!r.isError, r.text);
  assert.deepEqual(graphCalls.at(-1).body.template, {
    name: "convite_mediacao",
    language: { code: "pt_BR" },
    components: [
      { type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "05/10 às 14h" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "abc123" }] },
    ],
  });

  r = await call("whatsapp_send_buttons", {
    to: USER,
    body: "Você aceita a proposta?",
    buttons: [{ id: "sim", title: "Aceito" }, { id: "nao", title: "Não aceito" }],
  });
  assert.equal(graphCalls.at(-1).body.interactive.action.buttons[1].reply.id, "nao");

  r = await call("whatsapp_send_list", {
    to: USER,
    body: "Escolha um horário",
    button_text: "Ver horários",
    sections: [{ rows: [{ id: "h1", title: "Segunda 10h" }, { id: "h2", title: "Terça 15h" }] }],
  });
  assert.equal(graphCalls.at(-1).body.interactive.type, "list");

  r = await call("whatsapp_send_media", { to: USER, type: "document", link: "https://example.com/acordo.pdf", filename: "acordo.pdf", caption: "Minuta" });
  assert.deepEqual(graphCalls.at(-1).body.document, { link: "https://example.com/acordo.pdf", caption: "Minuta", filename: "acordo.pdf" });

  r = await call("whatsapp_send_media", { to: USER, type: "audio", media_id: "1", caption: "x" });
  assert.ok(r.isError && r.text.includes("caption"));
  r = await call("whatsapp_send_media", { to: USER, type: "image" });
  assert.ok(r.isError && r.text.includes("exactly one"));
  step("send: text, template, buttons, list, media payloads match the Cloud API format");

  r = await call("whatsapp_send_text", { to: "5500000000000", body: "x" });
  assert.ok(r.isError && r.text.includes("131030") && r.text.includes("Next step"), r.text);
  r = await call("whatsapp_send_text", { to: "123", body: "x" });
  assert.ok(r.isError);
  step("errors: Graph errors are mapped to actionable guidance");

  // --- Statuses -------------------------------------------------------------
  const status = (s, extra = {}) => envelope({ statuses: [{ id: textId, status: s, timestamp: String(now + 5), recipient_id: USER, ...extra }] });
  await postWebhook(status("delivered"));
  await postWebhook(status("sent")); // late, out-of-order status must not downgrade
  r = await call("whatsapp_get_message_status", { message_id: textId });
  assert.equal(r.data.status, "delivered");
  await postWebhook(status("failed", { errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "More than 24 hours have passed" } }] }));
  r = await call("whatsapp_get_message_status", { message_id: textId });
  assert.equal(r.data.status, "failed");
  assert.equal(r.data.error.code, 131047);
  assert.ok(r.data.error.next_step.includes("whatsapp_send_template"));
  step("status: out-of-order statuses handled, failures explained");

  r = await call("whatsapp_mark_as_read", { message_id: "wamid.IN2", show_typing: true });
  assert.deepEqual(graphCalls.at(-1).body, { messaging_product: "whatsapp", status: "read", message_id: "wamid.IN2", typing_indicator: { type: "text" } });
  r = await call("whatsapp_list_conversations", { unread_only: true });
  assert.equal(r.data.total, 0);
  r = await call("whatsapp_get_conversation", { phone: USER, limit: 3 });
  assert.equal(r.data.count, 3);
  assert.equal(r.data.has_more, true);
  step("read receipts and pagination");

  // --- Templates, media, account -------------------------------------------
  r = await call("whatsapp_list_templates", { status: "APPROVED" });
  assert.equal(r.data.templates[0].body_variables, 2);
  assert.equal(r.data.templates[0].buttons[0].type, "URL");
  assert.equal(graphCalls.at(-1).query.status, "APPROVED");

  r = await call("whatsapp_upload_media", { base64: PNG.toString("base64"), mime_type: "image/png", filename: "a.png" });
  assert.equal(r.data.media_id, "media-up-1");
  r = await call("whatsapp_upload_media", { url: "https://127.0.0.1/secret" });
  assert.ok(r.isError && r.text.includes("private or local"), r.text);
  r = await call("whatsapp_upload_media", { url: "http://example.com/a.png" });
  assert.ok(r.isError && r.text.includes("https"));

  r = await call("whatsapp_get_media", { media_id: "media-in-1", download: true });
  assert.equal(r.data.inlined, true);
  assert.equal(r.content[1].type, "image");
  assert.equal(r.content[1].data, PNG.toString("base64"));

  r = await call("whatsapp_get_phone_number");
  assert.equal(r.data.quality_rating, "GREEN"); // exercised the field-fallback path
  r = await call("whatsapp_get_business_profile");
  assert.equal(r.data.vertical, "PROF_SERVICES");
  r = await call("whatsapp_update_business_profile", {});
  assert.ok(r.isError);
  step("templates, media (upload, SSRF guard, inline image), account");

  await client.close();
  console.log("\nAll smoke checks passed.");
}

main()
  .catch((e) => {
    failed = true;
    console.error("\nSMOKE TEST FAILED\n", e);
  })
  .finally(() => {
    child?.kill("SIGTERM");
    graph.close();
    rmSync(dataDir, { recursive: true, force: true });
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  });
