// Private account-scoped device dashboard; reuses the owner's existing credential.
// No new admin password, public device list, or browser-side OAuth tokens.
export type AdminDevice = {
  id: string;
  displayName: string;
  platform: string;
  status: "online" | "offline" | "revoked";
  createdAt: string;
  lastSeenAt?: string;
};

type AdminSession = {
  userId: string;
  credentialVersion: string;
  expiresAt: number;
};

export type AdminStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
};

export type AdminDependencies = {
  authenticate(password: string): Promise<{ userId: string; credentialVersion: string } | null>;
  credentialVersion(): Promise<string>;
  devices(userId: string): Promise<AdminDevice[]>;
};

const COOKIE = "__Host-mcpv3-admin";
const SESSION_MS = 60 * 60 * 1000;
const PAGE = "/admin/devices";
const JSON_PATH = "/admin/devices/data";
const LOGOUT = "/admin/devices/logout";

export class DeviceAdminDashboard {
  constructor(private readonly storage: AdminStorage, private readonly deps: AdminDependencies) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/admin") {
      return new Response(null, { status: 303, headers: { location: PAGE, "cache-control": "no-store" } });
    }
    if (![PAGE, JSON_PATH, LOGOUT].includes(url.pathname)) return new Response(null, { status: 404 });
    const session = await this.readSession(request);
    if (url.pathname === JSON_PATH) {
      if (request.method !== "GET") return empty(405);
      if (!session) return json({ error: "authentication_required" }, 401);
      const devices = await this.deps.devices(session.userId);
      return json({ devices }, 200);
    }
    if (url.pathname === LOGOUT) {
      if (request.method !== "POST") return empty(405);
      if (!sameOrigin(request, url)) return empty(403);
      const token = cookie(request);
      if (token && /^[0-9a-f]{64}$/u.test(token)) await this.storage.delete(await sessionKey(token));
      const headers = new Headers({ location: PAGE, "cache-control": "no-store" });
      headers.set("set-cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return new Response(null, { status: 303, headers });
    }
    if (request.method === "GET") {
      return page(session ? dashboardPage() : loginPage(), 200);
    }
    if (request.method !== "POST") return empty(405);
    if (session || !sameOrigin(request, url) ||
        !(request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
      return empty(403);
    }
    const body = await request.text();
    if (body.length > 4096) return empty(413);
    const ipHash = await hashHex(request.headers.get("cf-connecting-ip") ?? "unknown");
    const throttleKey = `device-admin-attempts:v1:${ipHash}`;
    const throttle = await this.storage.get<{ attempts: number; resetAt: number }>(throttleKey);
    if (throttle && throttle.resetAt > Date.now() && throttle.attempts >= 5) {
      return new Response(null, { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
    }
    const password = new URLSearchParams(body).get("owner_password") ?? "";
    const identity = password.length <= 2048 ? await this.deps.authenticate(password) : null;
    if (!identity) {
      await this.storage.put(throttleKey, {
        attempts: throttle && throttle.resetAt > Date.now() ? throttle.attempts + 1 : 1,
        resetAt: throttle && throttle.resetAt > Date.now() ? throttle.resetAt : Date.now() + 60_000,
      });
      return page(loginPage(true), 401);
    }
    await this.storage.delete(throttleKey);
    const token = randomToken();
    await this.storage.put(await sessionKey(token), {
      userId: identity.userId,
      credentialVersion: identity.credentialVersion,
      expiresAt: Date.now() + SESSION_MS,
    } satisfies AdminSession);
    const headers = new Headers({ location: PAGE, "cache-control": "no-store" });
    headers.set("set-cookie", `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`);
    return new Response(null, { status: 303, headers });
  }

  private async readSession(request: Request): Promise<AdminSession | null> {
    const token = cookie(request);
    if (!token || !/^[0-9a-f]{64}$/u.test(token)) return null;
    const key = await sessionKey(token);
    const value = await this.storage.get<AdminSession>(key);
    if (!value) return null;
    if (value.expiresAt <= Date.now() ||
        value.credentialVersion !== await this.deps.credentialVersion()) {
      await this.storage.delete(key);
      return null;
    }
    return value;
  }
}

function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("origin") === url.origin;
}
function cookie(request: Request): string | undefined {
  return request.headers.get("cookie")?.split(";").map((v) => v.trim())
    .find((value) => value.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
}
function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}
async function hashHex(value: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map((v) => v.toString(16).padStart(2, "0")).join("");
}
async function sessionKey(token: string): Promise<string> {
  return "device-admin-session:v1:" + await hashHex(token);
}
const commonHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;
function empty(status: number): Response {
  return new Response(null, { status, headers: commonHeaders });
}
function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...commonHeaders, "content-type": "application/json; charset=utf-8" },
  });
}
function page(markup: string, status: number): Response {
  const nonce = randomToken();
  return new Response(markup.replaceAll("__CSP_NONCE__", nonce), {
    status,
    headers: {
      ...commonHeaders,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; connect-src 'self'; style-src 'nonce-" + nonce +
        "'; script-src 'nonce-" + nonce + "'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

// shadcn/ui-compatible dark design tokens; native Worker markup avoids introducing
// a React runtime or an independent frontend deployment solely for read-only data.
const CSS = `
:root{color-scheme:dark;--background:#09090b;--foreground:#fafafa;--muted:#a1a1aa;--card:#101013;--border:#27272a;--accent:#e4e4e7;--radius:.8rem}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
a{color:inherit}button,input{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid #a1a1aa;outline-offset:2px}
.shell{max-width:1150px;margin:auto;padding:32px 26px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 0 28px;border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:12px;font-size:15px;font-weight:650;letter-spacing:-.02em}
.mark{display:inline-flex;width:34px;height:34px;border-radius:10px;background:#fafafa;color:#09090b;align-items:center;justify-content:center;font-weight:800}
.pill{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--border);border-radius:999px;padding:4px 10px;font-size:12px;color:var(--muted)}
h1{font-size:clamp(27px,4vw,38px);letter-spacing:-.045em;line-height:1.15;margin:38px 0 10px}h2{font-size:15px;letter-spacing:-.02em;margin:0}p{color:var(--muted);margin:0 0 22px}
.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.button{border:1px solid var(--border);background:#18181b;color:#fafafa;border-radius:8px;padding:10px 14px;font-weight:550}
.button:hover{background:#27272a}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:28px 0}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:22px}
.stat-label{font-size:12px;color:var(--muted);font-weight:550}.stat{font-size:32px;letter-spacing:-.04em;font-weight:650;margin:10px 0 0}
.panel-header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px}
.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;white-space:nowrap}th{text-transform:none;color:var(--muted);font-size:12px;font-weight:500;border-bottom:1px solid var(--border);padding:12px}
td{padding:16px 12px;border-bottom:1px solid var(--border)}tr:last-child td{border-bottom:0}
.name{font-weight:600}.small{color:var(--muted);font-size:12px}.status{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border);border-radius:999px;padding:3px 9px;font-size:12px}
.dot{width:7px;height:7px;border-radius:50%;background:#71717a}.online .dot{background:#34d399}.offline .dot{background:#fbbf24}
.empty{padding:50px 10px;text-align:center;color:var(--muted)}
.login{max-width:390px;margin:13vh auto 0;padding:30px}.login h1{font-size:25px;margin:22px 0 8px}.login label{display:block;margin:22px 0 7px;font-weight:550}
.login input{width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;background:#09090b;color:var(--foreground)}
.login button{width:100%;margin-top:18px;background:#fafafa;color:#09090b;border:0;border-radius:8px;padding:12px;font-weight:650}
footer{margin:30px 0;color:var(--muted);font-size:12px}#error{color:#fca5a5}
@media(max-width:700px){.shell{padding:22px 14px}.stats{grid-template-columns:1fr}.card{padding:18px}.panel-header{align-items:flex-start;flex-direction:column}}
`;

function loginPage(invalid = false): string {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP V3 — Acesso</title>
<style nonce="__CSP_NONCE__">${CSS}</style><main class="card login"><div class="brand"><span class="mark">M</span>MCP V3</div>
<h1>Painel de dispositivos</h1><p>Entre com a senha da sua conta MCP V3 para visualizar os computadores conectados.</p>
${invalid ? '<p id="error" role="alert">Credenciais não reconhecidas.</p>' : ""}
<form method="post" action="/admin/devices"><label for="password">Senha da conta</label><input id="password" name="owner_password" type="password" autocomplete="current-password" required><button type="submit">Entrar</button></form>
</main></html>`;
}
function dashboardPage(): string {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP V3 — Dispositivos</title>
<style nonce="__CSP_NONCE__">${CSS}</style>
<div class="shell">
<header><div class="brand"><span class="mark">M</span>MCP V3 <span class="pill">Administração</span></div><form method="post" action="/admin/devices/logout"><button type="submit" class="button">Sair</button></form></header>
<main><h1>Computadores conectados</h1><p>Visão dos dispositivos vinculados à sua conta. O registro acontece após a autorização OAuth na instalação.</p>
<div class="controls"><button class="button" id="refresh" type="button">Atualizar</button><span class="small" id="updated" role="status">Carregando…</span></div>
<section class="stats" aria-label="Resumo">
<div class="card"><div class="stat-label">Total de dispositivos</div><div class="stat" id="total">—</div></div>
<div class="card"><div class="stat-label">Conectados</div><div class="stat" id="online">—</div></div>
<div class="card"><div class="stat-label">Desconectados</div><div class="stat" id="offline">—</div></div>
</section>
<section class="card"><div class="panel-header"><h2>Seus dispositivos</h2><span class="pill">Somente leitura</span></div><div class="table-wrap">
<table><thead><tr><th>Computador</th><th>Plataforma</th><th>Status</th><th>Última atividade</th><th>Registrado em</th></tr></thead><tbody id="devices"><tr><td colspan="5" class="empty">Carregando…</td></tr></tbody></table>
</div></section><footer>Novas máquinas aparecem automaticamente após a primeira autorização. Acesso associado à sua conta MCP V3.</footer></main></div>
<script nonce="__CSP_NONCE__">
(function(){
  const byId=id=>document.getElementById(id);
  const when=value=>{if(!value)return "—";const date=new Date(value);return isNaN(date.getTime())?"—":new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(date)};
  const cell=(row,value,cls)=>{const td=document.createElement("td");td.textContent=value;if(cls)td.className=cls;row.appendChild(td);return td};
  async function refresh(){
    byId("updated").textContent="Atualizando…";
    try{
      const response=await fetch("/admin/devices/data",{credentials:"same-origin",cache:"no-store"});
      if(response.status===401){location.reload();return}
      if(!response.ok)throw new Error("unavailable");
      const data=await response.json(),devices=Array.isArray(data.devices)?data.devices:[];
      byId("total").textContent=String(devices.length);
      byId("online").textContent=String(devices.filter(d=>d.status==="online").length);
      byId("offline").textContent=String(devices.filter(d=>d.status==="offline").length);
      const body=byId("devices");body.replaceChildren();
      if(!devices.length){const tr=document.createElement("tr");cell(tr,"Nenhum computador registrado ainda.","empty").colSpan=5;body.appendChild(tr)}
      for(const d of devices){
        const tr=document.createElement("tr");
        const name=cell(tr,d.displayName||"Computador","name");
        name.title=d.id||"";
        cell(tr,d.platform||"—");
        const badge=cell(tr,"");badge.className="status "+(d.status==="online"?"online":d.status==="offline"?"offline":"");
        const dot=document.createElement("span");dot.className="dot";badge.appendChild(dot);
        badge.appendChild(document.createTextNode(d.status==="online"?"Conectado":d.status==="revoked"?"Revogado":"Desconectado"));
        cell(tr,when(d.lastSeenAt),"small");cell(tr,when(d.createdAt),"small");
        body.appendChild(tr);
      }
      byId("updated").textContent="Atualizado às "+new Date().toLocaleTimeString("pt-BR");
    }catch{byId("updated").textContent="Não foi possível atualizar os dispositivos."}
  }
  byId("refresh").addEventListener("click",refresh);refresh();
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh()});
  setInterval(()=>{if(!document.hidden)refresh()},15000);
})();
</script></html>`;
}
