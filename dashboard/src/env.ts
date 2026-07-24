/**
 * The build-time environment, spec section 11.3.
 *
 * This value is inlined by Vite from `VITE_ENVIRONMENT` at BUILD time -- it is a
 * compile-time constant in the shipped bundle, not something fetched or detected
 * when the page loads. That is the whole point of section 11.3's requirement:
 * the environment banner is driven by "a value baked in at deploy time, not a
 * runtime toggle", so no runtime bug (a bad fetch, a stale cache, a wrong host)
 * can ever make it claim the wrong environment.
 *
 * The two real deployments set it explicitly:
 *   - testnet:    VITE_ENVIRONMENT=testnet    vite build
 *   - production: VITE_ENVIRONMENT=production vite build
 * A plain `vite dev` or a build with the var unset is reported as "development",
 * which the banner renders distinctly so it is never mistaken for production.
 */

export type Environment = "testnet" | "production" | "development";

function resolveEnvironment(): Environment {
  const raw = import.meta.env.VITE_ENVIRONMENT;
  if (raw === "testnet" || raw === "production") return raw;
  return "development";
}

/** The environment this bundle was built for. A module-level constant. */
export const ENVIRONMENT: Environment = resolveEnvironment();
