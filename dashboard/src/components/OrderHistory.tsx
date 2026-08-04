/**
 * This bot's order history (this session's brief item 4). Newest first (the
 * backend orders by `created_at` desc). Driven through the shared `HistoryTable`.
 */

import type { Order } from "../api/types";
import { HistoryTable, type Column } from "./HistoryTable";
import { SideBadge } from "./SideBadge";
import { formatMoney, formatQuantity, formatTime } from "../format";

const STATUS_CLASS: Record<string, string> = {
  pending: "text-sky-300",
  partially_filled: "text-amber-300",
  filled: "text-emerald-300",
  cancelled: "text-zinc-500",
};

function OrderStatus({ status }: { status: string }) {
  return (
    <span className={`text-xs font-medium uppercase tracking-wide ${STATUS_CLASS[status] ?? "text-zinc-300"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

const COLUMNS: readonly Column<Order>[] = [
  { key: "side", header: "Side", render: (o) => <SideBadge side={o.side} /> },
  { key: "price", header: "Price", align: "right", render: (o) => <span className="tabular">{formatMoney(o.price)}</span> },
  { key: "quantity", header: "Quantity", align: "right", render: (o) => <span className="tabular">{formatQuantity(o.quantity)}</span> },
  {
    key: "filled",
    header: "Filled",
    align: "right",
    render: (o) => <span className="tabular text-zinc-400">{formatQuantity(o.filledQuantity)}</span>,
  },
  { key: "status", header: "Status", render: (o) => <OrderStatus status={o.status} /> },
  {
    key: "created",
    header: "Created",
    align: "right",
    render: (o) => <span className="text-xs text-zinc-500">{formatTime(o.createdAt)}</span>,
  },
];

export function OrderHistory({ orders }: { orders: readonly Order[] }) {
  return (
    <HistoryTable
      title="Orders"
      rows={orders}
      columns={COLUMNS}
      getKey={(o) => o.id}
      emptyLabel="No orders recorded for this bot yet."
    />
  );
}
