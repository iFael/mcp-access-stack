import { OAUTH_REPROVISION_PATH } from "./auth-state.js";
import { verifyOperationHmac } from "./operation-hmac.js";

const SIGNATURE_DOMAIN = "mcp-v3-update-control:oauth-reprovision";

export function verifyOAuthReprovisionHmac(
  request: Request,
  operationId: string,
  secret: string | undefined,
): Promise<boolean> {
  return verifyOperationHmac(request, operationId, secret, {
    domain: SIGNATURE_DOMAIN,
    path: OAUTH_REPROVISION_PATH,
  });
}
