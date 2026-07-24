/**
 * Placeholder destination for `/bots/:id`.
 *
 * The real bot detail view is the NEXT session's work; this exists only so the
 * navigation wired from the list this session has somewhere to land. It reads
 * and shows the id from the route so the routing is demonstrably correct, then
 * says plainly that the view is not built yet.
 */

import { Link, useParams } from "react-router-dom";

export function BotDetailPlaceholder() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="space-y-4">
      <Link to="/" className="text-sm text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline">
        ← Back to bots
      </Link>
      <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-12 text-center">
        <div className="text-sm font-medium text-zinc-300">
          Detail view for <span className="tabular text-zinc-100">{id}</span>
        </div>
        <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500">
          This view isn’t built yet — it’s the next session. The navigation from the bot list is
          already wired, so building this page is all that remains.
        </p>
      </div>
    </div>
  );
}
