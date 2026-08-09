import { config } from "dotenv";

/**
 * Loads `.env.local` then `.env` into `process.env`, before any other module
 * is imported. Mirrors @nestjs/config's own envFilePath precedence: earlier
 * files win, and a real shell/OS env var always wins over either file (dotenv
 * never overrides a key already present in process.env).
 *
 * Must be the very first import in main.ts - modules like config/networks.ts
 * read process.env in top-level const initializers, which run at import time,
 * before ConfigModule.forRoot()'s own dotenv side effect (app.module.ts) has
 * had a chance to run.
 */
export function loadEnvFiles(): void {
  config({ path: ".env.local", override: false });
  config({ path: ".env", override: false });
}

loadEnvFiles();
