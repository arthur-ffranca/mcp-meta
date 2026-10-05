import type { Config } from "../config.js";
import { REQUEST_TIMEOUT_MS } from "../constants.js";

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    error_data?: { details?: string };
    error_user_msg?: string;
  };
}

export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly details?: string,
    readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  form?: FormData;
}

export class GraphClient {
  constructor(private readonly cfg: Config) {}

  private url(path: string, query?: QueryParams): string {
    const url = new URL(`${this.cfg.graphBaseUrl}/${this.cfg.graphVersion}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.accessToken}`,
      Accept: "application/json",
    };
    let body: string | FormData | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await fetch(this.url(path, opts.query), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new GraphApiError(`Non-JSON response from Graph API (HTTP ${res.status})`, res.status);
    }

    const err = (json as GraphErrorBody).error;
    if (!res.ok || err) {
      throw new GraphApiError(
        err?.message ?? `Graph API request failed (HTTP ${res.status})`,
        res.status,
        err?.code,
        err?.error_subcode,
        err?.error_data?.details ?? err?.error_user_msg,
        err?.fbtrace_id,
      );
    }
    return json as T;
  }

  /** Downloads a media file from the short-lived URL returned by GET /{media-id}. */
  async download(url: string, maxBytes: number): Promise<Buffer> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new GraphApiError(`Media download failed (HTTP ${res.status})`, res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`Media is ${buf.byteLength} bytes, above the ${maxBytes}-byte inline limit.`);
    }
    return buf;
  }
}

/** Next-step guidance for the WhatsApp error codes an agent is most likely to hit. */
const ERROR_HINTS: Record<number, string> = {
  10: "The access token lacks permission for this resource. It needs whatsapp_business_messaging and whatsapp_business_management on this WABA.",
  100: "Invalid parameter. Check IDs, field names and the payload shape.",
  190: "The access token is invalid or expired. Generate a permanent System User token in Meta Business Settings and update WHATSAPP_ACCESS_TOKEN.",
  200: "Permission denied for this business asset. Confirm the System User has access to the WABA and phone number.",
  130429: "Cloud API throughput limit reached. Wait a few seconds and retry.",
  131009: "A parameter value is invalid (often the phone number or a template component).",
  131026: "Message undeliverable: the number may not be on WhatsApp, may not have accepted the latest terms, or uses an outdated app version.",
  131030: "Recipient is not in the allowed list. With a test phone number, add the recipient in the Meta app dashboard (WhatsApp > API Setup).",
  131047: "More than 24h since the user's last message, so free-form messages are blocked. Use whatsapp_send_template with an approved template.",
  131048: "Spam rate limit hit: too many messages from this number were blocked or flagged. Slow down and check quality with whatsapp_get_phone_number.",
  131049: "Meta chose not to deliver this marketing message to the user (per-user marketing limit). Do not retry immediately.",
  131051: "Unsupported message type.",
  131052: "Media download error: WhatsApp could not fetch the user's media.",
  131053: "Media upload error: unsupported type or file too large. Check the MIME type and size limits.",
  131056: "Too many messages to this same recipient in a short period. Wait before sending again.",
  132000: "Template parameter count mismatch. Fetch the template with whatsapp_list_templates and pass exactly the variables it defines.",
  132001: "Template not found in that language. Check name and language code (e.g. pt_BR) with whatsapp_list_templates.",
  132005: "Template text too long after variable substitution.",
  132007: "Template content violates a WhatsApp policy.",
  132012: "Template parameter format mismatch (wrong type for a variable).",
  132015: "Template is paused due to low quality. Edit it or use another template.",
  132016: "Template was disabled permanently due to low quality.",
  133010: "Phone number is not registered on the Cloud API. Register it before sending.",
};

export function explainError(error: unknown): string {
  if (error instanceof GraphApiError) {
    const parts = [`Error: ${error.message}`];
    if (error.code !== undefined) parts.push(`(code ${error.code}${error.subcode ? `/${error.subcode}` : ""})`);
    if (error.details) parts.push(`Details: ${error.details}`);
    const hint =
      (error.code !== undefined ? ERROR_HINTS[error.code] : undefined) ??
      (error.status === 429 ? ERROR_HINTS[130429] : undefined);
    if (hint) parts.push(`Next step: ${hint}`);
    if (error.fbtraceId) parts.push(`[fbtrace_id ${error.fbtraceId}]`);
    return parts.join(" ");
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "Error: the request to the Graph API timed out. Try again.";
    }
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

export function hintForCode(code: number): string | undefined {
  return ERROR_HINTS[code];
}
