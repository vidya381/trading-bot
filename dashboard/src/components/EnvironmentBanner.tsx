/**
 * The persistent, unmissable environment banner (spec section 11.3, this
 * session's brief item 4).
 *
 * Driven ENTIRELY by `ENVIRONMENT`, which Vite bakes in at build time (see
 * `env.ts`). Nothing here fetches or detects the environment, so no runtime bug
 * can make it wrong -- a testnet build always says testnet, because the string
 * is a compile-time constant in this bundle.
 *
 *   - testnet:     loud amber "NOT REAL MONEY" bar. The one that must never be
 *                  missed when real funds are one deployment away.
 *   - development: loud violet bar, so a local `vite dev` is never mistaken for
 *                  a real environment.
 *   - production:  a slim, quiet neutral bar. Present (so the environment is
 *                  always labelled) but deliberately undramatic.
 */

import { ENVIRONMENT, type Environment } from "../env";

interface BannerStyle {
  readonly label: string;
  readonly className: string;
  readonly prominent: boolean;
}

const STYLES: Record<Environment, BannerStyle> = {
  testnet: {
    label: "TESTNET — NOT REAL MONEY",
    className: "bg-amber-400 text-amber-950",
    prominent: true,
  },
  development: {
    label: "LOCAL DEVELOPMENT — NOT A DEPLOYED ENVIRONMENT",
    className: "bg-violet-500 text-violet-50",
    prominent: true,
  },
  production: {
    label: "PRODUCTION — LIVE FUNDS",
    className: "bg-zinc-800 text-zinc-300 border-b border-zinc-700",
    prominent: false,
  },
};

export function EnvironmentBanner() {
  const style = STYLES[ENVIRONMENT];
  return (
    <div
      role="banner"
      aria-label={`Environment: ${ENVIRONMENT}`}
      className={[
        "w-full text-center font-semibold tracking-wide select-none",
        style.prominent ? "py-2 text-sm uppercase" : "py-1 text-xs uppercase",
        style.className,
      ].join(" ")}
    >
      {style.label}
    </div>
  );
}
