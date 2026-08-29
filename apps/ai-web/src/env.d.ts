/// <reference types="astro/client" />

interface AiWebRuntimeEnv {
  AI_BACKEND?: Fetcher;
}

interface RuntimeContext {
  env: AiWebRuntimeEnv;
}

declare module "cloudflare:workers" {
  export const env: AiWebRuntimeEnv;
}

declare namespace App {
  interface Locals {
    runtime?: RuntimeContext;
  }
}
