import type { EntityType } from '@factory/db';

/**
 * Every connector implements one interface (PRD §5):
 * auth(), sync(), read(entity), write(action), webhookHandler(), health().
 * Credentials are stored encrypted per tenant (config) with scoped tokens.
 */

export type SyncEntity =
  | 'ledgers'
  | 'stock_items'
  | 'groups'
  | 'godowns'
  | 'vouchers'
  | 'parties'
  | 'items'
  | 'orders'
  | 'invoices';

export interface NormalizedRecord {
  type: EntityType;
  sourceId: string;
  code?: string;
  name?: string;
  status?: string;
  amount?: number;
  qty?: number;
  rate?: number;
  date?: string;
  data?: Record<string, unknown>;
}

export interface SyncResult {
  connectorId: string;
  entity: SyncEntity;
  pulled: number;
  pushed: number;
  errors: string[];
  lastCursor: string | null;
}

export interface AuthResult {
  ok: boolean;
  mode: 'oauth' | 'device-token' | 'credentials' | 'file';
  expiresAt?: string;
  error?: string;
}

export interface WebhookEvent {
  connectorType: string;
  orgId: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface WebhookResult {
  ok: boolean;
  eventId?: string;
  duplicate?: boolean;
  error?: string;
}

export interface Connector {
  readonly type: string;
  /** Validate/refresh credentials. */
  auth(config: Record<string, unknown>): Promise<AuthResult>;
  /** Pull changes since last cursor; normalise into our tables. */
  sync(orgId: string, connectorId: string, entity: SyncEntity): Promise<SyncResult>;
  /** Read a normalised entity (pass-through for agent tools). */
  read(orgId: string, entity: SyncEntity, id?: string): Promise<NormalizedRecord[]>;
  /** Write an action out to the source system (e.g., Tally voucher import). */
  write(orgId: string, action: { type: string; payload: Record<string, unknown> }): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** Verify + dedupe inbound webhooks (WhatsApp, email, connector). */
  webhookHandler(event: WebhookEvent): Promise<WebhookResult>;
  /** Health check shown in the connectors UI. */
  health(orgId: string): Promise<{ status: 'connected' | 'error' | 'disconnected'; lastSyncAt?: string; lastError?: string }>;
}
