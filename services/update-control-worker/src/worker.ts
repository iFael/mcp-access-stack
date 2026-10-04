import { UpdateControlAuthController, type UpdateControlEnvironment } from "./auth-state.js";

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface UpdateControlWorkerEnv extends UpdateControlEnvironment {
  readonly UPDATE_CONTROL_AUTH_STATE: DurableObjectNamespaceLike;
}

export class UpdateControlAuthState {
  private readonly controller: UpdateControlAuthController;

  constructor(state: { readonly storage: import("@mcp-access-stack/mcp-owner-auth").OwnerOAuthStorage }, env: UpdateControlWorkerEnv) {
    this.controller = new UpdateControlAuthController(state, env);
  }

  fetch(request: Request): Promise<Response> {
    return this.controller.fetch(request);
  }
}

const updateControlWorker = {
  async fetch(request: Request, env: UpdateControlWorkerEnv): Promise<Response> {
    const id = env.UPDATE_CONTROL_AUTH_STATE.idFromName("update-control-auth-v1");
    const state = env.UPDATE_CONTROL_AUTH_STATE.get(id);
    return state.fetch(request);
  },
};

export default updateControlWorker;
