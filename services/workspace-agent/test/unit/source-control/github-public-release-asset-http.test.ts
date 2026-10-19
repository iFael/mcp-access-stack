import {describe,expect,it,jest} from "@jest/globals";
import {GitHubHttpClient} from "../../../src/source-control/github-http-client.js";
import type {GitHubCredentialProvider} from "../../../src/source-control/github-credential-provider.js";
const credentialProvider:GitHubCredentialProvider={
  getCredential:async()=>({token:"test-github-token",source:"gh-cli-user"}),
};
describe("bounded authenticated release checksum download",()=>{
  it("uses API bearer only on github.com, never forwards it to the asset CDN",async()=>{
    const seen:Array<{url:string;init:RequestInit}>=[];
    const fetchImpl=jest.fn(async(url:string,init:RequestInit)=>{
      seen.push({url,init});
      if(seen.length===1)return new Response(null,{status:302,headers:{
        location:"https://release-assets.githubusercontent.com/test/asset?signature=opaque",
      }});
      return new Response("a".repeat(64)+" *v1.0.0-windows-x64.zip\n",{status:200});
    });
    const client=new GitHubHttpClient({credentialProvider,fetchImpl:fetchImpl as typeof fetch});
    expect((await client.getReleaseAssetChecksum("octo","repo",42)).startsWith("a")).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toBe("https://api.github.com/repos/octo/repo/releases/assets/42");
    expect((seen[0]!.init.headers as Record<string,string>).Authorization).toBe("Bearer test-github-token");
    expect(seen[0]!.init.redirect).toBe("manual");
    expect((seen[1]!.init.headers as Record<string,string>|undefined)?.Authorization).toBeUndefined();
    expect(seen[1]!.init.redirect).toBe("error");
  });
  it("refuses untrusted redirects, missing data and oversized bodies",async()=>{
    const evil=jest.fn(async()=>new Response(null,{status:302,headers:{
      location:"https://attacker.example/asset",
    }}));
    const client=new GitHubHttpClient({credentialProvider,fetchImpl:evil as typeof fetch});
    await expect(client.getReleaseAssetChecksum("octo","repo",42)).rejects.toThrow();
    expect(evil).toHaveBeenCalledTimes(1);
    const huge=new GitHubHttpClient({credentialProvider,
      fetchImpl:async()=>new Response("x".repeat(513),{status:200})});
    await expect(huge.getReleaseAssetChecksum("octo","repo",42)).rejects.toThrow();
    await expect(client.getReleaseAssetChecksum("octo","repo",0)).rejects.toThrow();
  });
});
