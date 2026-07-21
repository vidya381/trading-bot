// Gives `env` from "cloudflare:test" the same shape as the Worker's own Env,
// which is generated from wrangler.jsonc by `npm run cf-typegen`.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
