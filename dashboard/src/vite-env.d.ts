/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The environment this build targets, BAKED IN at build time (spec section
   * 11.3). Set on the build command, e.g. `VITE_ENVIRONMENT=testnet vite build`.
   * Never detected at runtime, so a runtime bug cannot make the environment
   * banner wrong. Absent during plain `vite dev`, where `env.ts` treats it as
   * "development".
   */
  readonly VITE_ENVIRONMENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
