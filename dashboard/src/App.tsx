/**
 * App shell and routing.
 *
 * The environment banner is OUTSIDE the routed area so it is present on every
 * page, unmissable, and never unmounts as you navigate (spec section 11.3).
 * Routes:
 *   /            the dashboard (status strip + bot list)
 *   /bots/:id    the bot detail view (read-only summary, strategy state, history)
 *   *            anything else redirects home
 */

import { Navigate, Route, Routes } from "react-router-dom";
import { EnvironmentBanner } from "./components/EnvironmentBanner";
import { Dashboard } from "./pages/Dashboard";
import { BotDetail } from "./pages/BotDetail";

export function App() {
  return (
    <div className="flex min-h-full flex-col">
      <EnvironmentBanner />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/bots/:id" element={<BotDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
