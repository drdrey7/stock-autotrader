import { proxyPublicApiRequest } from "./preview-api-proxy";

export interface PreviewEnv {
  ASSETS: Fetcher;
  ENVIRONMENT: "preview";
  PUBLIC_API_ORIGIN: string;
}

type PreviewFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function handlePreviewRequest(
  request: Request,
  env: PreviewEnv,
  fetcher: PreviewFetcher = fetch,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return proxyPublicApiRequest(request, env.PUBLIC_API_ORIGIN, fetcher);
  }
  return env.ASSETS.fetch(request);
}

export default {
  fetch(request: Request, env: PreviewEnv): Promise<Response> {
    return handlePreviewRequest(request, env);
  },
};
