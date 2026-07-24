/**
 * A generic history table (this session's brief item 4).
 *
 * Orders and trades are genuinely the same SHAPE of thing -- a list of
 * timestamped rows, newest first -- even though their columns differ, so the
 * responsive container is shared here once (a real <table> at `md` and up,
 * stacked label/value cards below, the same pattern as the bot list) and the
 * two callers supply only their column definitions. That is the "share a
 * component shape where the underlying data genuinely matches" the brief asks
 * for, applied to the histories rather than to the strategy state.
 */

import type { ReactNode } from "react";

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly align?: "left" | "right";
  readonly render: (row: T) => ReactNode;
}

export function HistoryTable<T>({
  title,
  rows,
  columns,
  getKey,
  emptyLabel,
}: {
  title: string;
  rows: readonly T[];
  columns: readonly Column<T>[];
  getKey: (row: T) => string;
  emptyLabel: string;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{title}</h2>
        <span className="tabular text-xs text-zinc-500">{rows.length}</span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
          {emptyLabel}
        </div>
      ) : (
        <>
          {/* Desktop: real table (md and up) */}
          <div className="hidden overflow-x-auto rounded-lg border border-zinc-800 md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-800 bg-zinc-900/60 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      className={`px-4 py-3 font-medium ${col.align === "right" ? "text-right" : ""}`}
                    >
                      {col.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {rows.map((row) => (
                  <tr key={getKey(row)} className="transition-colors hover:bg-zinc-800/40">
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={`px-4 py-3 ${col.align === "right" ? "text-right" : ""}`}
                      >
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: cards (below md) */}
          <div className="grid gap-3 md:hidden">
            {rows.map((row) => (
              <div
                key={getKey(row)}
                className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4"
              >
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  {columns.map((col) => (
                    <div key={col.key}>
                      <dt className="text-xs uppercase tracking-wide text-zinc-500">{col.header}</dt>
                      <dd className="text-zinc-200">{col.render(row)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
