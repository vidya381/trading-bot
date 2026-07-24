/**
 * The shapes the dashboard API returns, mirrored from the backend's
 * `src/api/serialize.ts` and `src/api/envelope.ts` (build step 10.4).
 *
 * Two conventions the backend fixes and this file must honour:
 *   - Every money value is a DECIMAL STRING ("500.00000000"), never a JS number
 *     -- real-money precision past 2^53 or on fractional cents. Kept as `string`
 *     here; parse only where arithmetic is genuinely needed.
 *   - Fields are camelCase; the snake_case D1 seam is hidden by the backend.
 */

/** The one envelope every endpoint answers in (`src/api/envelope.ts`). */
export type ApiEnvelope<T> =
  | { readonly data: T; readonly error: null }
  | { readonly data: null; readonly error: { readonly code: string; readonly message: string } };

/** A bot's lifecycle status (spec section 8.1). */
export type BotStatus = "created" | "running" | "halted" | "stopped";

export type Strategy = "dca" | "grid";

/**
 * The held position + realized profit, read from the bot's own Durable Object
 * state (`positionOf` in serialize.ts). `null` when the object holds no state
 * (an orphaned row). `realizedGross` is named honestly: gross realized profit
 * before fees -- the backend deliberately does not call it "pnl".
 */
export type Position =
  | {
      readonly strategy: "grid";
      readonly heldQuantity: string;
      readonly realizedGross: string;
    }
  | {
      readonly strategy: "dca";
      readonly heldQuantity: string;
      readonly averageEntryPrice: string;
      readonly cost: string;
      readonly realizedGross: string;
    };

/** One bot in the list view (`botSummary` in serialize.ts, `GET /api/bots`). */
export interface Bot {
  readonly id: string;
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: string;
  readonly strategy: Strategy;
  readonly status: BotStatus;
  readonly allocatedCapital: string;
  readonly capitalAsset: string;
  readonly stopLossPct: string;
  readonly takeProfitPct: string | null;
  readonly haltReason: string | null;
  readonly haltedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly position: Position | null;
  readonly orphaned: boolean;
}

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertCategory = "trading" | "system";

/** One alert (`alertView` in serialize.ts, `GET /api/alerts`). */
export interface Alert {
  readonly id: string;
  readonly severity: AlertSeverity;
  readonly category: AlertCategory;
  readonly alertType: string;
  readonly botInstanceId: string | null;
  readonly source: string;
  readonly message: string;
  readonly resolved: boolean;
  readonly createdAt: number;
  readonly notifiedAt: number | null;
}
