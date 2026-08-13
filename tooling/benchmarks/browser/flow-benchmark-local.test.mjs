import assert from "node:assert/strict";
import test from "node:test";
import {
  extractToolResult,
  mcpCall,
} from "./flow-benchmark-local.mjs";

test("continues a deferred VS Code execution without repeating its code", async () => {
  const inputs = [];
  const client = {
    async callTool(_name, input) {
      inputs.push(input);
      return inputs.length === 1
        ? {
            content: [{
              type: "text",
              text:
                "[deferredResultId=12345678-abcd-4321-abcd-1234567890ab] " +
                "The code has not finished executing yet.",
            }],
          }
        : {
            content: [{
              type: "text",
              text: 'Result: "Histórico"\nPage Title: Histórico\nURL: http://example.test/',
            }],
          };
    },
  };

  const response = await mcpCall(client, "run_playwright_code", {
    pageId: "page-1",
    code: "return 'Histórico';",
    timeoutMs: 10_000,
  });

  assert.equal(response.callCount, 2);
  assert.equal(extractToolResult(response.result), "Histórico");
  assert.deepEqual(inputs[1], {
    pageId: "page-1",
    deferredResultId: "12345678-abcd-4321-abcd-1234567890ab",
    timeoutMs: 10_000,
  });
  assert.equal("code" in inputs[1], false);
});

test("extracts JSON results before page metadata", () => {
  const result = {
    content: [{
      type: "text",
      text:
        'Result: "{\\"query\\":\\"consulta legacy\\",\\"asserted\\":true}"\n' +
        "Page Title: Flow benchmark legacy\n" +
        "URL: http://127.0.0.1/\n" +
        "Snapshot: <unchanged>",
    }],
  };
  assert.equal(
    extractToolResult(result),
    '{"query":"consulta legacy","asserted":true}',
  );
});
