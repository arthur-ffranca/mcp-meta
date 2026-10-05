import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { phoneVariants } from "./phone.js";

export type Direction = "in" | "out";
export type MessageStatus = "accepted" | "sent" | "delivered" | "read" | "failed" | "received";

export interface StoredMessage {
  id: string;
  wa_id: string;
  direction: Direction;
  type: string;
  /** Human-readable rendering of the message (body, caption or a short description). */
  text: string | null;
  media_id: string | null;
  mime_type: string | null;
  filename: string | null;
  context_id: string | null;
  timestamp: number;
  status: MessageStatus;
  status_timestamp: number | null;
  error_code: number | null;
  error_message: string | null;
  read: number;
}

export interface ConversationSummary {
  wa_id: string;
  name: string | null;
  last_inbound_ts: number | null;
  unread: number;
  last_message_id: string | null;
  last_direction: Direction | null;
  last_type: string | null;
  last_text: string | null;
  last_timestamp: number | null;
}

export type NewMessage = Omit<
  StoredMessage,
  "status_timestamp" | "error_code" | "error_message" | "read"
> & { read?: number };

const STATUS_RANK: Record<string, number> = { accepted: 0, sent: 1, delivered: 2, read: 3 };

/** Local message log. The Cloud API has no "read history" endpoint, so webhooks and sends are persisted here. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "whatsapp.sqlite3"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS contacts (
        wa_id TEXT PRIMARY KEY,
        name TEXT,
        last_inbound_ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        wa_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT,
        media_id TEXT,
        mime_type TEXT,
        filename TEXT,
        context_id TEXT,
        timestamp INTEGER NOT NULL,
        status TEXT NOT NULL,
        status_timestamp INTEGER,
        error_code INTEGER,
        error_message TEXT,
        read INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_wa_ts ON messages (wa_id, timestamp);
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertContact(waId: string, name?: string | null, inboundTs?: number): void {
    this.db
      .prepare(
        `INSERT INTO contacts (wa_id, name, last_inbound_ts) VALUES (?, ?, ?)
         ON CONFLICT(wa_id) DO UPDATE SET
           name = COALESCE(excluded.name, contacts.name),
           last_inbound_ts = MAX(COALESCE(contacts.last_inbound_ts, 0), COALESCE(excluded.last_inbound_ts, 0))`,
      )
      .run(waId, name ?? null, inboundTs ?? null);
  }

  /** Returns false when the message was already stored (webhooks are delivered at least once). */
  insertMessage(m: NewMessage): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
           (id, wa_id, direction, type, text, media_id, mime_type, filename, context_id, timestamp, status, read)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.wa_id,
        m.direction,
        m.type,
        m.text,
        m.media_id,
        m.mime_type,
        m.filename,
        m.context_id,
        m.timestamp,
        m.status,
        m.read ?? (m.direction === "out" ? 1 : 0),
      );
    return Number(res.changes) > 0;
  }

  /** Applies a delivery status. Statuses can arrive out of order, so they never move backwards. */
  updateStatus(
    id: string,
    waId: string,
    status: MessageStatus,
    ts: number,
    errorCode?: number,
    errorMessage?: string,
  ): void {
    const current = this.getMessage(id);
    if (!current) {
      // Sent by another system sharing this number: keep a stub so the status is still queryable.
      this.upsertContact(waId);
      this.insertMessage({
        id,
        wa_id: waId,
        direction: "out",
        type: "unknown",
        text: null,
        media_id: null,
        mime_type: null,
        filename: null,
        context_id: null,
        timestamp: ts,
        status: "accepted",
      });
    }
    const currentStatus = current?.status ?? "accepted";
    const advances =
      status === "failed" ||
      (currentStatus !== "failed" && (STATUS_RANK[status] ?? 0) >= (STATUS_RANK[currentStatus] ?? 0));
    if (!advances) return;
    this.db
      .prepare(
        `UPDATE messages SET status = ?, status_timestamp = ?, error_code = ?, error_message = ? WHERE id = ?`,
      )
      .run(status, ts, errorCode ?? null, errorMessage ?? null, id);
  }

  getMessage(id: string): StoredMessage | undefined {
    return this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as unknown as
      | StoredMessage
      | undefined;
  }

  /** Maps a user-supplied number to the wa_id known locally, covering the Brazilian 9th-digit variants. */
  resolveWaId(digits: string): string {
    const stmt = this.db.prepare(`SELECT wa_id FROM contacts WHERE wa_id = ?`);
    for (const candidate of phoneVariants(digits)) {
      const row = stmt.get(candidate) as { wa_id: string } | undefined;
      if (row) return row.wa_id;
    }
    return digits;
  }

  getContact(waId: string): { wa_id: string; name: string | null; last_inbound_ts: number | null } | undefined {
    return this.db.prepare(`SELECT * FROM contacts WHERE wa_id = ?`).get(waId) as unknown as
      | { wa_id: string; name: string | null; last_inbound_ts: number | null }
      | undefined;
  }

  listConversations(limit: number, offset: number, unreadOnly: boolean): ConversationSummary[] {
    return this.db
      .prepare(
        `SELECT * FROM (
           SELECT c.wa_id, c.name, c.last_inbound_ts,
             (SELECT COUNT(*) FROM messages m WHERE m.wa_id = c.wa_id AND m.direction = 'in' AND m.read = 0) AS unread,
             lm.id AS last_message_id, lm.direction AS last_direction, lm.type AS last_type,
             lm.text AS last_text, lm.timestamp AS last_timestamp
           FROM contacts c
           LEFT JOIN messages lm ON lm.id = (
             SELECT id FROM messages WHERE wa_id = c.wa_id ORDER BY timestamp DESC, rowid DESC LIMIT 1
           )
         )
         WHERE (? = 0 OR unread > 0)
         ORDER BY COALESCE(last_timestamp, 0) DESC
         LIMIT ? OFFSET ?`,
      )
      .all(unreadOnly ? 1 : 0, limit, offset) as unknown as ConversationSummary[];
  }

  countConversations(unreadOnly: boolean): number {
    const row = this.db
      .prepare(
        unreadOnly
          ? `SELECT COUNT(DISTINCT wa_id) AS n FROM messages WHERE direction = 'in' AND read = 0`
          : `SELECT COUNT(*) AS n FROM contacts`,
      )
      .get() as { n: number };
    return Number(row.n);
  }

  /** Newest `limit` messages older than `before` (unix seconds), returned oldest-first. */
  getConversation(waId: string, limit: number, before?: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE wa_id = ? AND timestamp < ?
         ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      )
      .all(waId, before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as StoredMessage[];
    return rows.reverse();
  }

  /** Marks the given inbound message and every earlier one in the same conversation as read. */
  markReadUpTo(messageId: string): void {
    const msg = this.getMessage(messageId);
    if (!msg) return;
    this.db
      .prepare(`UPDATE messages SET read = 1 WHERE wa_id = ? AND direction = 'in' AND timestamp <= ?`)
      .run(msg.wa_id, msg.timestamp);
  }
}
