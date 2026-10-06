export interface MicrosoftIdentityEnvironment {
  readonly MCP_UPDATE_CONTROL_PUBLIC_URL?: string;
  readonly MICROSOFT_CLIENT_ID?: string;
  readonly MICROSOFT_CLIENT_SECRET?: string;
  readonly MICROSOFT_TENANT?: string;
}

export type VerifiedMicrosoftIdentity = {
  subject: string;
  displayName: string;
  email?: string;
};

const MAX_RESPONSE_BYTES = 32 * 1024;

export async function exchangeMicrosoftAuthorizationCode(
  env: MicrosoftIdentityEnvironment,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedMicrosoftIdentity> {
  const publicBaseUrl = parsePublicBaseUrl(requireValue(env.MCP_UPDATE_CONTROL_PUBLIC_URL, "MCP_UPDATE_CONTROL_PUBLIC_URL"));
  const clientId = requireGuid(env.MICROSOFT_CLIENT_ID, "MICROSOFT_CLIENT_ID");
  const clientSecret = requireSecret(env.MICROSOFT_CLIENT_SECRET, "MICROSOFT_CLIENT_SECRET");
  const tenant = requireTenant(env.MICROSOFT_TENANT);
  if (!validOpaqueText(code, 1, 4096) || !/^[A-Za-z0-9_-]{43}$/u.test(codeVerifier)) {
    throw new Error("Microsoft authorization response is invalid.");
  }

  const tokenEndpoint = new URL("https://login.microsoftonline.com/" + tenant + "/oauth2/v2.0/token");
  const redirectUri = new URL("/auth/microsoft/callback", publicBaseUrl).href;
  const tokenResponse = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      scope: "openid profile email",
    }),
  });
  const tokenPayload = await readBoundedJson(tokenResponse);
  if (!tokenResponse.ok || !isRecord(tokenPayload) || typeof tokenPayload.access_token !== "string" ||
      tokenPayload.access_token.length < 16 || tokenPayload.access_token.length > 16384) {
    throw new Error("Microsoft token exchange was rejected.");
  }

  const userInfoResponse = await fetchImpl("https://graph.microsoft.com/oidc/userinfo", {
    method: "GET",
    headers: {
      authorization: "Bearer " + tokenPayload.access_token,
      accept: "application/json",
    },
  });
  const userInfo = await readBoundedJson(userInfoResponse);
  if (!userInfoResponse.ok || !isRecord(userInfo) ||
      typeof userInfo.sub !== "string" || !validOpaqueText(userInfo.sub, 1, 512)) {
    throw new Error("Microsoft identity could not be resolved.");
  }
  const displayName = chooseDisplayName(userInfo);
  const email = typeof userInfo.email === "string" && validOpaqueText(userInfo.email, 3, 320)
    ? userInfo.email
    : undefined;
  return {
    subject: userInfo.sub,
    displayName,
    ...(email ? { email } : {}),
  };
}

function chooseDisplayName(userInfo: Record<string, unknown>): string {
  for (const candidate of [userInfo.name, userInfo.email, userInfo.sub]) {
    if (typeof candidate === "string" && validOpaqueText(candidate, 1, 200)) {
      return candidate.trim();
    }
  }
  throw new Error("Microsoft identity display name is unavailable.");
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error("Microsoft response exceeded the configured size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Microsoft response exceeded the configured size limit.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Microsoft response was not valid JSON.");
  }
}

function parsePublicBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP_UPDATE_CONTROL_PUBLIC_URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("MCP_UPDATE_CONTROL_PUBLIC_URL must be an HTTPS origin.");
  }
  return url;
}

function requireGuid(value: string | undefined, name: string): string {
  const normalized = requireValue(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)) {
    throw new Error(name + " must be a GUID.");
  }
  return normalized;
}

function requireTenant(value: string | undefined): string {
  const normalized = requireValue(value, "MICROSOFT_TENANT");
  if (normalized === "common" || normalized === "organizations" || normalized === "consumers" ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)) {
    return normalized;
  }
  throw new Error("MICROSOFT_TENANT is invalid.");
}

function requireSecret(value: string | undefined, name: string): string {
  const normalized = requireValue(value, name);
  if (normalized.length < 16 || normalized.length > 4096 || /[\r\n\0]/u.test(normalized)) {
    throw new Error(name + " is invalid.");
  }
  return normalized;
}

function requireValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(name + " is required.");
  return normalized;
}

function validOpaqueText(value: string, minimum: number, maximum: number): boolean {
  return value.length >= minimum && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
