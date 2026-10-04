import type { OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";
import {
  UpdateControlAuthController,
  type UpdateControlDurableStorage,
  type UpdateControlEnvironment,
} from "./auth-state.js";

interface DurableObjectStorageLike extends Omit<OwnerOAuthStorage, "delete"> {
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list(options: { prefix: string; limit: number }): Promise<Map<string, unknown>>;
}

interface DurableObjectStateLike {
  readonly storage: DurableObjectStorageLike;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface UpdateControlWorkerEnv extends UpdateControlEnvironment {
  readonly UPDATE_CONTROL_AUTH_STATE: DurableObjectNamespaceLike;
}

export class UpdateControlAuthState {
  private readonly controller: UpdateControlAuthController;

  constructor(state: DurableObjectStateLike, env: UpdateControlWorkerEnv) {
    const storage: UpdateControlDurableStorage = {
      get: <T>(key: string) => state.storage.get<T>(key),
      put: <T>(key: string, value: T) => state.storage.put(key, value),
      delete: (key: string) => state.storage.delete(key),
      listPrefix: (prefix, limit) => state.storage.list({ prefix, limit }),
      deleteMany: (keys) => state.storage.delete(keys),
    };
    this.controller = new UpdateControlAuthController({ storage }, env);
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
