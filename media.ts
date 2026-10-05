import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_INLINE_MEDIA_BYTES, MAX_UPLOAD_BYTES, REQUEST_TIMEOUT_MS } from "../constants.js";
import { assertPublicHttpsUrl } from "../services/net.js";
import { handler, ok, type ToolContext } from "./shared.js";

interface MediaInfo {
  id: string;
  url: string;
  mime_type: string;
  sha256?: string;
  file_size?: number;
}

export function registerMediaTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "whatsapp_upload_media",
    {
      title: "Upload media to WhatsApp",
      description: `Upload a file to WhatsApp and get a media id to use in whatsapp_send_media or as a template header. Uploaded media is kept by Meta for 30 days.

Provide the file either as 'url' (public https URL the server downloads; redirects are not followed) or as 'base64' content. Max 16MB through this tool.

Returns: { media_id, mime_type, bytes }`,
      inputSchema: {
        url: z.string().url().optional().describe("Public HTTPS URL of the file"),
        base64: z.string().optional().describe("File content encoded as base64"),
        mime_type: z
          .string()
          .regex(/^[\w.+-]+\/[\w.+-]+$/)
          .optional()
          .describe("MIME type, e.g. application/pdf, image/jpeg. Required with base64; detected from the response with url"),
        filename: z.string().max(240).default("file").describe("File name, e.g. 'acordo.pdf'"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handler(async ({ url, base64, mime_type, filename }) => {
      if (Boolean(url) === Boolean(base64)) throw new Error("Provide exactly one of 'url' or 'base64'.");

      let bytes: Buffer;
      let mime = mime_type;
      if (url) {
        const safe = await assertPublicHttpsUrl(url);
        const res = await fetch(safe, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`Could not download ${safe.hostname} (HTTP ${res.status}).`);
        bytes = Buffer.from(await res.arrayBuffer());
        mime ??= res.headers.get("content-type")?.split(";")[0]?.trim();
      } else {
        bytes = Buffer.from(base64 ?? "", "base64");
      }
      if (!mime) throw new Error("Could not determine the MIME type; pass 'mime_type' explicitly.");
      if (bytes.byteLength === 0) throw new Error("The file is empty.");
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new Error(`File is ${bytes.byteLength} bytes; this tool accepts up to ${MAX_UPLOAD_BYTES}. Send larger files with whatsapp_send_media using 'link'.`);
      }

      const form = new FormData();
      form.set("messaging_product", "whatsapp");
      form.set("type", mime);
      form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
      const res = await ctx.graph.request<{ id: string }>("POST", `${ctx.cfg.phoneNumberId}/media`, { form });
      return ok({ media_id: res.id, mime_type: mime, bytes: bytes.byteLength });
    }),
  );

  server.registerTool(
    "whatsapp_get_media",
    {
      title: "Get WhatsApp media",
      description: `Get metadata for a media file received from a user (media_id comes from whatsapp_get_conversation). With download=true, images up to 4MB are returned inline so they can be viewed; other file types return metadata only.

The returned 'url' expires in about 5 minutes and requires the server's access token, so it cannot be opened directly in a browser.

Returns: { media_id, mime_type, file_size, sha256, url, inlined }`,
      inputSchema: {
        media_id: z.string().min(1).describe("Media id from an inbound message"),
        download: z.boolean().default(false).describe("Return the image content inline (images only)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler(async ({ media_id, download }) => {
      const info = await ctx.graph.request<MediaInfo>("GET", media_id, {
        query: { phone_number_id: ctx.cfg.phoneNumberId },
      });
      const data = {
        media_id: info.id,
        mime_type: info.mime_type,
        file_size: info.file_size ?? null,
        sha256: info.sha256 ?? null,
        url: info.url,
        inlined: false,
      };
      const mime = info.mime_type.split(";")[0]?.trim() ?? info.mime_type;
      if (!download || !mime.startsWith("image/")) return ok(data);
      if ((info.file_size ?? 0) > MAX_INLINE_MEDIA_BYTES) {
        throw new Error(`Image is ${info.file_size} bytes, above the ${MAX_INLINE_MEDIA_BYTES}-byte inline limit. Call again with download=false for metadata.`);
      }
      const buf = await ctx.graph.download(info.url, MAX_INLINE_MEDIA_BYTES);
      data.inlined = true;
      const result = ok(data);
      result.content.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
      return result;
    }),
  );
}
