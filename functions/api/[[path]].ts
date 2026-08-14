import { proxyPublicApiRequest } from "../../apps/web/preview-api-proxy";

interface PreviewEnv {
  PUBLIC_API_ORIGIN?: string;
}

export const onRequest = ({ request, env }: { request: Request; env: PreviewEnv }) =>
  proxyPublicApiRequest(request, env.PUBLIC_API_ORIGIN);
