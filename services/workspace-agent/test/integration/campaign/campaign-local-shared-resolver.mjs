import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const localSharedDist = pathToFileURL(fileURLToPath(
  new URL("../../../../../packages/mcp-core/dist/index.js", import.meta.url),
)).href;
// Test-only resolution of the package compiled in this worktree. This hook
// runs only in the forked fixture, never the production agent or root npm.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@vs-code-gpt/shared") {
      return { url: localSharedDist, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
