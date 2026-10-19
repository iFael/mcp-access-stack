import {constants} from "node:fs";
import {lstat,open,realpath} from "node:fs/promises";
import {dirname,isAbsolute} from "node:path";
import {AppError} from "@vs-code-gpt/shared";
const TOKEN=/^[A-Za-z0-9_.-]{32,256}$/u;

/** Protected, bounded token reader shared by source/workflow WSS providers.
 * No environment value or raw file contents are ever logged. */
export async function readProtectedOracleProviderToken(
  file:string,env:Readonly<Record<string,string|undefined>>,
):Promise<string>{
  try{
    if(!isAbsolute(file))throw new Error("absolute required");
    const before=await lstat(file);
    if(!before.isFile() || before.isSymbolicLink() ||
      before.size<32 || before.size>258)throw new Error("not regular");
    const mode=before.mode&0o777;
    const dir=env.CREDENTIALS_DIRECTORY;
    const systemd=mode===0o440 && dir!==undefined && isAbsolute(dir) &&
      (await realpath(dirname(file)))===(await realpath(dir));
    if((mode&0o077)!==0 && !systemd)throw new Error("permissions");
    const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const after=await handle.stat();
      if(after.ino!==before.ino || after.dev!==before.dev || !after.isFile() ||
        after.size!==before.size)throw new Error("changed");
      const raw=await handle.readFile("utf8");
      const token=raw.endsWith("\r\n")?raw.slice(0,-2):
        raw.endsWith("\n")?raw.slice(0,-1):raw;
      if(!TOKEN.test(token))throw new Error("invalid");
      return token;
    }finally{await handle.close();}
  }catch{
    throw new AppError("CAPABILITY_UNSUPPORTED","Oracle provider credential unavailable.");
  }
}
