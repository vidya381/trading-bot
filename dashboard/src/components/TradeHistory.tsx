/**
 * This bot's trade (fill) history (this session's brief item 4). Newest first
 * (the backend orders by `executed_at` desc). Fees are shown honestly with their
 * asset, and the reporting-currency fee when the backend has converted it
 * (section 5.5) -- otherwise "—", never a guessed value.
 */

import type { Trade } from "../api/types";
import { HistoryTable, type Column } from "./HistoryTable";
import { formatMoney, formatQuantity, formatTime } from "../format";
import { Unit } from "./Unit";

/**
 * The fee, in whatever asset the venue charged it in -- which is the reason it
 * is formatted as a QUANTITY and not as money: `feeAsset` is frequently the
 * exchange's own token or the base asset, not the capital asset, so the
 * two-decimal money rule would be the wrong rule and (for a small crypto fee)
 * would round the whole charge away.
 */
function Fee({ trade }: { trade: Trade }) {
  return (
    <span className="tabular text-zinc-400">
      {formatQuantity(trade.feeAmount)}
      <Unit>{trade.feeAsset}</Unit>
    </span>
  );
}

const COLUMNS: readonly Column<Trade>[] = [
  { key: "price", header: "Price", align: "right", render: (t) => <span className="tabular">{formatMoney(t.price)}</span> },
  { key: "quantity", header: "Quantity", align: "right", render: (t) => <span className="tabular">{formatQuantity(t.quantity)}</span> },
  { key: "fee", header: "Fee", align: "right", render: (t) => <Fee trade={t} /> },
  {
    key: "executed",
    header: "Executed",
    align: "right",
    render: (t) => <span className="text-xs text-zinc-500">{formatTime(t.executedAt)}</span>,
  },
];

export function TradeHistory({ trades }: { trades: readonly Trade[] }) {
  return (
    <HistoryTable
      title="Trades"
      rows={trades}
      columns={COLUMNS}
      getKey={(t) => t.id}
      emptyLabel="No fills recorded for this bot yet."
    />
  );
}
