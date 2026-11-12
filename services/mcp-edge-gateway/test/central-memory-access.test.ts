import { describe,expect,it } from "@jest/globals";
import { authorizeCentralMemory } from "../src/control-plane/central-memory-access.js";
import { EdgeAccountStore,type AccountStorage } from "../src/control-plane/account-store.js";
class VolatileStore implements AccountStorage {
  private readonly store=new Map<string,unknown>();
  async get<T>(key:string):Promise<T|undefined>{return this.store.get(key) as T|undefined;}
  async put<T>(key:string,value:T):Promise<void>{this.store.set(key,structuredClone(value));}
  async delete(key:string):Promise<boolean>{return this.store.delete(key);}
}
const args=(repositoryId:string)=>({workspaceId:"mcp-access-stack",repositoryId});

describe("Central Memory Edge repository authorization",()=>{
  it("permits repository owners and blocks unrelated users and invalid destinations",async()=>{
    const accounts=new EdgeAccountStore(new VolatileStore());
    const user=await accounts.createSingleUserIdentity("owner");
    const repo=await accounts.createRepository(user.id,"private");
    const acl=(id:string,repositoryId:string)=>accounts.getRepositoryForUser(id,repositoryId);
    expect(await authorizeCentralMemory("memory_context",args(repo.id),user.id,acl)).toBeNull();
    expect(await authorizeCentralMemory("memory_update",args(repo.id),user.id,acl)).toBeNull();
    expect(await authorizeCentralMemory("memory_context",args(repo.id),undefined,acl))
      .toBe("IDENTITY_REQUIRED");
    expect(await authorizeCentralMemory("memory_update",args(repo.id),
      "usr_22222222-2222-4222-8222-222222222222",acl)).toBe("REPOSITORY_NOT_FOUND");
    expect(await authorizeCentralMemory("memory_context",
      {workspaceId:"mcp-access-stack-local",repositoryId:repo.id},user.id,acl))
      .toBe("MEMORY_ROUTE_INVALID");
    expect(await authorizeCentralMemory("memory_context",args(""),user.id,acl))
      .toBe("REPOSITORY_NOT_FOUND");
  });

  it("enforces viewer read-only privileges when a repository is shared",async()=>{
    const allowed=async(_id:string,_repo:string)=>({role:"viewer" as const});
    expect(await authorizeCentralMemory("memory_context",args("repo_example"),
      "usr_22222222-2222-4222-8222-222222222222",allowed)).toBeNull();
    expect(await authorizeCentralMemory("memory_update",args("repo_example"),
      "usr_22222222-2222-4222-8222-222222222222",allowed)).toBe("PERMISSION_DENIED");
  });
});