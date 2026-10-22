import assert from "node:assert/strict";
import test from "node:test";
import { compareReleaseTags, selectPublishedRelease, resolvePublishedRelease } from "./select-mcp-v3-release.mjs";

const asset = "-windows-x64.zip";
function release(tag, { prerelease = tag.includes("-"), withAssets = true, draft = false } = {}) {
  const assets = withAssets ? [{name:tag + asset},{name:tag + asset + ".sha256"}] : [{name:"oracle-source.tar.gz"}];
  return { tag_name:tag, prerelease, draft, assets };
}

test("semver comparator orders prereleases without treating numeric IDs as text", () => {
  assert.equal(compareReleaseTags("v1.1.0-beta.100","v1.1.0-beta.99"), 1);
  assert.equal(compareReleaseTags("v1.1.0","v1.1.0-beta.100"), 1);
  assert.equal(compareReleaseTags("v1.2.0","v1.1.999"), 1);
  assert.equal(compareReleaseTags("v1.1.0-beta.1","v1.1.0-beta.1"), 0);
});

test("chooses signed asset pair on requested channel and refuses downgrade", () => {
  const releases=[
    release("v1.1.0-beta.100"),release("v1.1.0-beta.99"),
    release("v1.1.0-beta.101",{withAssets:false}),
    release("v1.1.0-companion.999"),
    release("v1.1.0"),release("v1.1.0-beta.200",{draft:true}),
  ];
  assert.deepEqual(selectPublishedRelease(releases,{
    channel:"prerelease",assetSuffix:asset,currentReleaseId:"1.1.0-beta.99",
  }),{status:"available",tag:"v1.1.0-beta.100"});
  assert.deepEqual(selectPublishedRelease(releases,{
    channel:"stable",assetSuffix:asset,currentReleaseId:"1.1.0-beta.99",
  }),{status:"available",tag:"v1.1.0"});
  assert.deepEqual(selectPublishedRelease(releases,{
    channel:"companion",assetSuffix:asset,currentReleaseId:"1.1.0-companion.998",
  }),{status:"available",tag:"v1.1.0-companion.999"});
  assert.deepEqual(selectPublishedRelease(releases,{
    channel:"prerelease",assetSuffix:asset,currentReleaseId:"1.1.0-beta.100",
  }),{status:"up-to-date"});
});

test("excludes Oracle-only releases and refuses invalid catalog shape", () => {
  assert.deepEqual(selectPublishedRelease([release("v1.1.0-beta.200",{withAssets:false})],{
    channel:"prerelease",assetSuffix:asset,currentReleaseId:"1.1.0-beta.99",
  }),{status:"up-to-date"});
  for(const bad of [{channel:"arbitrary"},{assetSuffix:"-arbitrary.exe"},{currentReleaseId:"../etc"}]){
    assert.throws(()=>selectPublishedRelease([],{
      channel:"prerelease",assetSuffix:asset,currentReleaseId:"1.1.0-beta.1",...bad,
    }),/RELEASE_SELECTION_INVALID/u);
  }
});

test("resolves only public typed metadata and refuses bad upstream",async()=>{
  let calls=0;
  const response=await resolvePublishedRelease({
    repository:"iFael/mcp-access-stack",channel:"prerelease",
    assetSuffix:asset,currentReleaseId:"1.1.0-beta.99",
  },async(url,init)=>{
    calls++;
    assert.equal(url,"https://api.github.com/repos/iFael/mcp-access-stack/releases?per_page=100");
    assert.equal(init.redirect,"error");
    return {ok:true,json:async()=>[release("v1.1.0-beta.100")]};
  });
  assert.equal(calls,1);
  assert.equal(response.tag,"v1.1.0-beta.100");
  await assert.rejects(()=>resolvePublishedRelease({
    repository:"iFael/mcp-access-stack",channel:"companion",
    assetSuffix:asset,currentReleaseId:"1.1.0-companion.998",
  },async()=>({ok:true,json:async()=>[]})),/RELEASE_CATALOG_EMPTY/u);
  await assert.rejects(()=>resolvePublishedRelease({
    repository:"../secret",channel:"stable",assetSuffix:asset,currentReleaseId:"1.1.0",
  },async()=>{throw Error("should not fetch")}),/RELEASE_REPOSITORY_INVALID/u);
});
