export type BrowserViewerScope =
  | {
      kind: "runtime";
      runtimeId: string;
      browserEpoch: string;
      taskId: string;
      tabId: string;
    }
  | {
      kind: "device";
      deviceId: string;
      taskId: string;
      tabId: string;
    };

type ViewerSession = {
  scope: BrowserViewerScope;
  userId: string;
  viewerDeviceId: string;
  credentialVersion: string;
  expiresAt: number;
};

export type ViewerStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
};

export type BrowserLiveViewerDependencies = {
  authenticate(
    ownerPassword: string,
    userName: string,
    userPassword: string,
  ): Promise<{ userId: string; credentialVersion: string } | null>;
  credentialVersion(): Promise<string>;
  registerViewerDevice(userId: string, existingDeviceId?: string): Promise<string>;
  viewerDeviceAuthorized(userId: string, viewerDeviceId: string): Promise<boolean>;
  authorizeSource(userId: string, scope: BrowserViewerScope): Promise<boolean>;
  frame(
    request: Request,
    userId: string,
    scope: BrowserViewerScope,
    afterSeq: number,
  ): Promise<Response>;
};

const COOKIE_NAME = "__Secure-mcpv3-viewer";
const DEVICE_COOKIE_NAME = "__Host-mcpv3-viewer-device";
const SESSION_MS = 60 * 60 * 1000;
const UUID_BODY =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const DEVICE_ID_PATTERN = new RegExp(`^dev_${UUID_BODY}$`, "iu");
const RUNTIME_ID_PATTERN = new RegExp(`^rt_${UUID_BODY}$`, "iu");
const EPOCH_PATTERN = new RegExp(`^${UUID_BODY}$`, "iu");
const VIEW_ID_PATTERN = /^[^\u0000-\u001f\u007f/\\?#&]{1,128}$/u;

export class BrowserLiveViewer {
  constructor(
    private readonly storage: ViewerStorage,
    private readonly dependencies: BrowserLiveViewerDependencies,
  ) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parsed = parseViewerPath(url.pathname);
    if (!parsed) return new Response(null, { status: 404 });
    const { scope, isFrame, pagePath } = parsed;
    const session = await this.readSession(request, scope);

    if (isFrame) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      if (!session) return json({ error: "viewer_auth_required" }, 401);
      if (!(await this.dependencies.authorizeSource(session.userId, scope))) {
        return json({ error: "view_unavailable" }, 404);
      }
      const afterSeqText = url.searchParams.get("afterSeq") ?? "0";
      if (!/^\d{1,16}$/u.test(afterSeqText) ||
          !Number.isSafeInteger(Number(afterSeqText))) {
        return json({ error: "invalid_sequence" }, 400);
      }
      return withPrivateHeaders(
        await this.dependencies.frame(
          request,
          session.userId,
          scope,
          Number(afterSeqText),
        ),
      );
    }

    if (request.method === "GET") {
      if (session) {
        if (!(await this.dependencies.authorizeSource(session.userId, scope))) {
          return new Response(null, { status: 404 });
        }
        return html(viewerPage(), 200);
      }
      return html(loginPage(), 200);
    }

    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (session) return new Response(null, { status: 403 });
    if (request.headers.get("origin") !== url.origin ||
        !(request.headers.get("content-type") ?? "")
          .startsWith("application/x-www-form-urlencoded")) {
      return new Response(null, { status: 403 });
    }

    const raw = await request.text();
    if (raw.length > 8_192) return new Response(null, { status: 413 });
    const throttleKey =
      `browser-viewer-throttle:v2:${await sha256Hex(
        request.headers.get("cf-connecting-ip") ?? "unknown",
      )}`;
    const throttle = await this.storage.get<{
      attempts: number;
      resetAt: number;
    }>(throttleKey);
    if (throttle && throttle.resetAt > Date.now() && throttle.attempts >= 5) {
      return new Response(null, {
        status: 429,
        headers: { "retry-after": "60", "cache-control": "no-store" },
      });
    }

    const fields = new URLSearchParams(raw);
    const identity = await this.dependencies.authenticate(
      fields.get("owner_password") ?? "",
      fields.get("user_name") ?? "",
      fields.get("user_password") ?? "",
    );
    if (!identity) {
      await this.storage.put(throttleKey, {
        attempts:
          throttle && throttle.resetAt > Date.now()
            ? throttle.attempts + 1
            : 1,
        resetAt:
          throttle && throttle.resetAt > Date.now()
            ? throttle.resetAt
            : Date.now() + 60_000,
      });
      return html(loginPage("Credentials were not accepted."), 401);
    }
    await this.storage.delete(throttleKey);

    if (!(await this.dependencies.authorizeSource(identity.userId, scope))) {
      return new Response(null, { status: 404 });
    }

    const previousDeviceId = readCookie(request, DEVICE_COOKIE_NAME);
    const viewerDeviceId = await this.dependencies.registerViewerDevice(
      identity.userId,
      previousDeviceId && DEVICE_ID_PATTERN.test(previousDeviceId)
        ? previousDeviceId
        : undefined,
    );
    const token = randomToken();
    const stored: ViewerSession = {
      scope,
      userId: identity.userId,
      viewerDeviceId,
      credentialVersion: identity.credentialVersion,
      expiresAt: Date.now() + SESSION_MS,
    };
    const key = await sessionKey(token);
    const activeKey =
      `browser-viewer-active:v2:${viewerDeviceId}:${await sha256Hex(scopeKey(scope))}`;
    const priorKey = await this.storage.get<string>(activeKey);
    if (priorKey) await this.storage.delete(priorKey);
    await this.storage.put(key, stored);
    await this.storage.put(activeKey, key);

    const headers = new Headers({
      location: pagePath,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    headers.append(
      "set-cookie",
      `${COOKIE_NAME}=${token}; Path=${pagePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
    );
    headers.append(
      "set-cookie",
      `${DEVICE_COOKIE_NAME}=${viewerDeviceId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
    );
    return new Response(null, { status: 303, headers });
  }

  private async readSession(
    request: Request,
    scope: BrowserViewerScope,
  ): Promise<ViewerSession | null> {
    const token = readCookie(request, COOKIE_NAME);
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    const key = await sessionKey(token);
    const record = await this.storage.get<ViewerSession>(key);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      await this.storage.delete(key);
      return null;
    }
    if (
      scopeKey(record.scope) !== scopeKey(scope) ||
      record.credentialVersion !== await this.dependencies.credentialVersion() ||
      readCookie(request, DEVICE_COOKIE_NAME) !== record.viewerDeviceId ||
      !(await this.dependencies.viewerDeviceAuthorized(
        record.userId,
        record.viewerDeviceId,
      ))
    ) {
      return null;
    }
    return record;
  }
}

function parseViewerPath(
  pathname: string,
): { scope: BrowserViewerScope; isFrame: boolean; pagePath: string } | null {
  const raw = pathname.split("/").filter(Boolean);
  let segments: string[];
  try {
    segments = raw.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (segments[0] !== "viewer") return null;

  const isFrame = segments.at(-1) === "frame";
  const base = isFrame ? segments.slice(0, -1) : segments;
  if (base[1] === "runtime" && base.length === 6) {
    const [, , runtimeId, browserEpoch, taskId, tabId] = base;
    if (
      !runtimeId ||
      !browserEpoch ||
      !taskId ||
      !tabId ||
      !RUNTIME_ID_PATTERN.test(runtimeId) ||
      !EPOCH_PATTERN.test(browserEpoch) ||
      !VIEW_ID_PATTERN.test(taskId) ||
      !VIEW_ID_PATTERN.test(tabId)
    ) {
      return null;
    }
    const scope: BrowserViewerScope = {
      kind: "runtime",
      runtimeId,
      browserEpoch,
      taskId,
      tabId,
    };
    return {
      scope,
      isFrame,
      pagePath: `/viewer/runtime/${encodeURIComponent(runtimeId)}/${encodeURIComponent(
        browserEpoch,
      )}/${encodeURIComponent(taskId)}/${encodeURIComponent(tabId)}`,
    };
  }

  if (base[1] === "device" && base.length === 5) {
    const [, , deviceId, taskId, tabId] = base;
    if (
      !deviceId ||
      !taskId ||
      !tabId ||
      !DEVICE_ID_PATTERN.test(deviceId) ||
      !VIEW_ID_PATTERN.test(taskId) ||
      !VIEW_ID_PATTERN.test(tabId)
    ) {
      return null;
    }
    const scope: BrowserViewerScope = {
      kind: "device",
      deviceId,
      taskId,
      tabId,
    };
    return {
      scope,
      isFrame,
      pagePath: `/viewer/device/${encodeURIComponent(deviceId)}/${encodeURIComponent(
        taskId,
      )}/${encodeURIComponent(tabId)}`,
    };
  }
  return null;
}

function scopeKey(scope: BrowserViewerScope): string {
  return scope.kind === "runtime"
    ? JSON.stringify([
        scope.kind,
        scope.runtimeId,
        scope.browserEpoch,
        scope.taskId,
        scope.tabId,
      ])
    : JSON.stringify([scope.kind, scope.deviceId, scope.taskId, scope.tabId]);
}

function readCookie(request: Request, name: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function loginPage(error = ""): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP V3 live viewer</title><style>body{font:16px system-ui;background:#171923;color:#f8f8ff;margin:3rem auto;max-width:24rem;padding:1rem}label{display:block;margin:1rem 0}input{box-sizing:border-box;width:100%;padding:.7rem;margin-top:.3rem}button{padding:.7rem 1rem}</style><h1>Browser live viewer</h1><p>Sign in to view this agent tab.</p>${error ? `<p role="alert">${error}</p>` : ""}<form method="post"><label>Shared account password<input name="owner_password" type="password" autocomplete="current-password" required></label><label>Profile name<input name="user_name" autocomplete="username" required></label><label>Personal password<input name="user_password" type="password" autocomplete="current-password" required></label><button type="submit">View tab</button></form></html>`;
}

function viewerPage(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP V3 live viewer</title><style>html,body{margin:0;background:#111;color:#eee;font:14px system-ui}header{padding:.6rem 1rem;background:#222}main{height:calc(100vh - 3rem);display:grid;place-items:center}img{max-width:100vw;max-height:calc(100vh - 3rem);object-fit:contain}</style><header>Agent browser · read only <span id="status">Connecting…</span></header><main><img id="frame" alt="Live agent browser tab" draggable="false"></main><script>let seq=0,generation=0;const image=document.getElementById('frame'),status=document.getElementById('status');const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function poll(run){while(run===generation){try{const result=await fetch(location.pathname+'/frame?afterSeq='+seq,{cache:'no-store'});if(run!==generation)break;if(result.status===404||result.status===401){status.textContent='View ended';break}if(result.status===204){await pause(250);continue}if(result.ok){const frame=await result.json();if(frame.seq>seq){seq=frame.seq;image.src='data:image/jpeg;base64,'+frame.data;status.textContent='Live'}}else{status.textContent='Reconnecting…';await pause(1000)}}catch{status.textContent='Reconnecting…';await pause(1000)}}}document.addEventListener('visibilitychange',()=>{generation++;if(!document.hidden)poll(generation)});if(!document.hidden)poll(generation);</script></html>`;
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; connect-src 'self'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function json(value: unknown, status: number): Response {
  return withPrivateHeaders(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

function withPrivateHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sessionKey(token: string): Promise<string> {
  return `browser-viewer-session:v2:${await sha256Hex(token)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
