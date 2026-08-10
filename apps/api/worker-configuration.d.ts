// Generated from wrangler.jsonc by `npm run cf:types`. Do not edit manually.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ENVIRONMENT: string;
    DEMO_MODE: string;
    ALLOWED_ORIGIN: string;
  }
}
interface Env extends Cloudflare.Env {}

