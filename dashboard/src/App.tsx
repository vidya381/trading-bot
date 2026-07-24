/**
 * App shell and routing.
 *
 * The environment banner AND the global kill-switch banner are OUTSIDE the routed
 * area so they are present on every page, unmissable, and never unmount as you
 * navigate (spec section 11.3; the kill-switch banner is this session's brief
 * item 6 — a tripped global switch is the most severe state the whole system can
 * be in and must be impossible to miss anywhere). The kill-switch banner renders
 * nothing while armed.
 * Routes:
 *   /             the dashboard (status strip + bot list)
 *   /bots/new     the create-bot form (declared before /bots/:id; "new" is a
 *                 static segment so it wins the match, and generated ids never
 *                 collide with it)
 *   /bots/:id     the bot detail view (read-only summary, strategy state, history)
 *   /kill-switch  the global kill switch control (status, trigger, reset)
 *   *             anything else redirects home
 */

import { Navigate, Route, Routes } from "react-router-dom";
import { EnvironmentBanner } from "./components/EnvironmentBanner";
import { KillSwitchBanner } from "./components/KillSwitchBanner";
import { Dashboard } from "./pages/Dashboard";
import { CreateBot } from "./pages/CreateBot";
import { BotDetail } from "./pages/BotDetail";
import { KillSwitchPage } from "./pages/KillSwitchPage";

export function App() {
  return (
    <div className="flex min-h-full flex-col">
      <EnvironmentBanner />
      <KillSwitchBanner />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/bots/new" element={<CreateBot />} />
          <Route path="/bots/:id" element={<BotDetail />} />
          <Route path="/kill-switch" element={<KillSwitchPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
