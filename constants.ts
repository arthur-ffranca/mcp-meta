export const SERVER_NAME = "whatsapp-mcp-server";
export const SERVER_VERSION = "1.0.0";

export const DEFAULT_GRAPH_BASE_URL = "https://graph.facebook.com";
export const DEFAULT_GRAPH_VERSION = "v26.0";

/** Max characters returned by a single tool call. */
export const CHARACTER_LIMIT = 25_000;
export const REQUEST_TIMEOUT_MS = 30_000;

/** Customer-service window: free-form messages are only deliverable within 24h of the last inbound message. */
export const SESSION_WINDOW_SECONDS = 24 * 60 * 60;

/** Largest image returned inline to the model by whatsapp_get_media. */
export const MAX_INLINE_MEDIA_BYTES = 4 * 1024 * 1024;
/** Largest file accepted by whatsapp_upload_media. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export const MIN_MCP_TOKEN_LENGTH = 24;
