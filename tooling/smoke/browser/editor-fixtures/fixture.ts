// Test-only real editor fixture. No editor API is used to perform the tested mutations.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type http from "node:http";
import type { BrowserContext, Page } from "playwright";
import type { PersonalBrowserBridge } from "../../../../services/mcp-gateway/src/companion/personal-browser-bridge.js";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const kinds = ["tinymce", "ckeditor", "codemirror", "monaco"] as const;
type Kind = typeof kinds[number];
const selectors: Record<Kind, string> = {
  tinymce: "#editor", ckeditor: ".ck-editor__editable", codemirror: ".cm-content",
  monaco: ".monaco-editor [role='textbox']",
};

export async function createEditorFixture() {
  // The local install is opt-in and is never required for the ordinary smoke.
  const { build } = require("esbuild") as {
    build(options: Record<string, unknown>): Promise<{outputFiles: Array<{path:string;contents:Uint8Array}>}>;
  };
  const bundle = await build({
    stdin: {resolveDir: fixtureRoot, contents: `
      import { ClassicEditor, Essentials, Paragraph } from "ckeditor5";
      import "ckeditor5/ckeditor5.css";
      import { EditorView, basicSetup } from "codemirror";
      window.startCKEditor = async () => {
        const editor = await ClassicEditor.create(document.querySelector("#editor"), {
          licenseKey: "GPL", plugins: [Essentials, Paragraph], toolbar: []
        });
        window.readEditor = () => editor.getData();
        document.body.dataset.ready = "true";
      };
      window.startCodeMirror = () => {
        const view = new EditorView({doc:"original", extensions:[basicSetup], parent:document.querySelector("#editor")});
        window.readEditor = () => view.state.doc.toString();
        document.body.dataset.ready = "true";
      };
    `},
    bundle:true, platform:"browser", format:"iife", write:false, outfile:"/editor-bundle.js",
    loader:{".svg":"dataurl", ".woff":"dataurl", ".woff2":"dataurl", ".ttf":"dataurl"},
  });
  const assets = new Map(bundle.outputFiles.map(file => [path.basename(file.path), file.contents]));
  const vendorRoots = {
    tiny: await realpath(path.join(fixtureRoot, "node_modules/tinymce")),
    monaco: await realpath(path.join(fixtureRoot, "node_modules/monaco-editor/min/vs")),
  };
  const hostnames = new Set(["real-editor.test", "real-editor-mid.test", "real-editor-leaf.test"]);
  const html = (kind: Kind) => {
    const start = kind === "tinymce" ? `
      <script src="/vendor/tiny/tinymce.min.js"></script>
      <script>tinymce.init({selector:"#editor",inline:true,license_key:"gpl",menubar:false,toolbar:false,
      promotion:false,base_url:"/vendor/tiny",suffix:".min",setup:editor=>editor.on("init",()=>{
        window.readEditor=()=>editor.getContent({format:"text"});document.body.dataset.ready="true";
      })});</script>` : kind === "monaco" ? `
      <link rel="stylesheet" href="/vendor/monaco/editor/editor.main.css">
      <script src="/vendor/monaco/loader.js"></script>
      <script>require.config({paths:{vs:"/vendor/monaco"}});
      require(["vs/editor/editor.main"],()=>{const editor=monaco.editor.create(document.querySelector("#editor"),{
        value:"original",language:"plaintext",ariaLabel:"Fixture Monaco",minimap:{enabled:false},automaticLayout:true
      });window.readEditor=()=>editor.getValue();document.body.dataset.ready="true";});</script>`
      : `<link rel="stylesheet" href="/editor-bundle.css"><script src="/editor-bundle.js"></script>
      <script>${kind==="ckeditor"?"startCKEditor()":"startCodeMirror()"}</script>`;
    return `<!doctype html><title>Real ${kind} editor fixture</title>
      <style>body{margin:12px}#editor{width:420px;min-height:70px;border:1px solid #999}
      ${kind==="monaco"?"#editor{height:200px}":""}.ck-editor__editable{min-height:70px}.cm-editor{min-height:70px}</style>
      <body><div id="editor">${kind==="tinymce"||kind==="ckeditor"?"<p>original</p>":""}</div>
      <input id="decoy" aria-label="Decoy" value="unchanged">${start}</body>`;
  };
  return {
    async handle(_req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
      if (!hostnames.has(url.hostname)) return false;
      const kind = url.searchParams.get("kind") as Kind;
      const send = (content: string | Uint8Array, mime: string) => {
        res.writeHead(200, {"content-type":mime,"cache-control":"no-store"}).end(content);
        return true;
      };
      try {
        const bundled = assets.get(url.pathname.slice(1));
        if (bundled) return send(bundled, url.pathname.endsWith(".css")?"text/css":"text/javascript");
        const match = /^\/vendor\/(tiny|monaco)\/([a-zA-Z0-9_./-]+)$/.exec(url.pathname);
        if (match && match[2]!.split("/").every(part=>part && part!=="." && part!=="..")) {
          const base = vendorRoots[match[1] as keyof typeof vendorRoots];
          const target = await realpath(path.join(base, match[2]!));
          if (!target.startsWith(base + path.sep)) throw Error("Asset escaped fixture root");
          const ext = path.extname(target);
          const mime = ({".js":"text/javascript",".css":"text/css",".woff":"font/woff",".woff2":"font/woff2",".ttf":"font/ttf",".svg":"image/svg+xml"} as Record<string,string>)[ext];
          if (!mime) throw Error("Unexpected asset type");
          return send(await readFile(target),mime);
        }
        if (!kinds.includes(kind)) throw Error("Unknown editor fixture");
        if (url.pathname === "/leaf") return send(html(kind),"text/html; charset=utf-8");
        if (url.pathname === "/" || url.pathname === "/mid") {
          const nested = url.searchParams.get("variant")==="nested";
          const hostname = url.pathname==="/mid" ? "real-editor-leaf.test"
            : nested ? "real-editor-mid.test" : url.searchParams.get("variant")==="same" ? "real-editor.test" : "real-editor-leaf.test";
          const destination = url.pathname==="/" && nested ? "/mid" : "/leaf";
          const name = url.pathname==="/mid" ? "leaf" : "editor";
          return send(`<!doctype html><title>Editor frame host</title><iframe name="${name}" src="http://${hostname}:${url.port}${destination}?kind=${kind}&variant=${url.searchParams.get("variant")==="same"?"same":nested?"nested":"cross"}" style="width:560px;height:380px;border:0"></iframe>`,"text/html; charset=utf-8");
        }
      } catch {
        // No arbitrary files or error paths are returned.
      }
      res.writeHead(404).end("missing");
      return true;
    },
  };
}

export async function verifyRealEditors(bridge: PersonalBrowserBridge, context: BrowserContext, port:number,
  waitForPage:(context:BrowserContext,url:string)=>Promise<Page>) {
  const failures: unknown[] = [];
  for (const kind of kinds) {
    for (const variant of kind==="monaco" ? ["top"] : ["same","cross","nested"]) {
      const taskId = "real-editor-" + kind + "-" + variant;
      const url = `http://real-editor.test:${port}/${variant==="top"?"leaf":""}?kind=${kind}&variant=${variant}`;
      try {
        const tabId = (await bridge.open({url,taskId})).tab.tabId;
        const page = await waitForPage(context,url);
        const frame = variant==="top" ? page : variant==="nested"
          ? page.frameLocator('iframe[name="editor"]').frameLocator('iframe[name="leaf"]')
          : page.frameLocator('iframe[name="editor"]');
        await frame.locator('body[data-ready="true"]').waitFor({timeout:30000});
        // Wait for model initialization, then use only the MCP's native input.
        const model = () => frame.locator("body").evaluate("window.readEditor()");
        const before = await model();
        if (before !== "original" && before !== "<p>original</p>") throw Error("Unexpected initial editor model: " + JSON.stringify(before));
        const replacement = "MCP editor replacement";
        const snapshot = await bridge.snapshot({tabId});
        let outcome = "completed";
        try {
          if (variant==="top") {
            const ref = snapshot.refs.find(item=>item.name.includes("Fixture Monaco") && item.role==="textbox")?.ref;
            if (!ref) throw Error("Monaco textbox ref missing: " + JSON.stringify(snapshot.refs.map(({ref,role,name})=>({ref,role,name})).slice(0,30)) + "; inputs: " + JSON.stringify(await page.evaluate("Array.from(document.querySelectorAll(\"textarea,[role=textbox]\")).map(e=>({tag:e.tagName,role:e.getAttribute(\"role\"),label:e.getAttribute(\"aria-label\"),className:e.className,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,editContext:!!e.editContext}))")) );
            await bridge.fill({tabId,ref,value:replacement});
          } else if (variant==="nested") {
            await bridge.frameSequence({tabId,steps:[{action:"fill",framePath:["editor","leaf"],locator:{selector:selectors[kind]},value:replacement}]});
          } else {
            await bridge.frameFill({tabId,frame:"editor",selector:selectors[kind],value:replacement});
          }
        } catch (error) {
          outcome = (error as {code?:string;message:string}).code ?? (error as Error).message;
        }
        let after = await model();
        for (let attempt=0; attempt<20 && after!==replacement && after!==`<p>${replacement}</p>`;attempt++) {
          await new Promise(resolve=>setTimeout(resolve,100));
          after=await model();
        }
        const decoy=await frame.locator("#decoy").inputValue();
        const observation={kind,variant,before,after,outcome,decoy};
        console.log("REAL_EDITOR_RESULT "+JSON.stringify(observation));
        if (outcome!=="completed" || (after!==replacement && after!==`<p>${replacement}</p>`) || decoy!=="unchanged" ||
            (before!=="original" && before!=="<p>original</p>")) failures.push(observation);
      } catch(error) {
        const observation={kind,variant,error:(error as Error).message};
        console.log("REAL_EDITOR_RESULT "+JSON.stringify(observation));
        failures.push(observation);
      } finally {
        await bridge.finishTask({taskId});
      }
    }
  }
  if(failures.length) throw Error("Real editor compatibility failed: "+JSON.stringify(failures));
  console.log("PERSONAL BROWSER REAL EDITORS PASS");
}
