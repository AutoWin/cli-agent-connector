import test from "node:test";
import assert from "node:assert/strict";
import { assemblePromptWithAttachments, buildTextDiff, normalizePromptAttachments, parseDiffProposals } from "../dist/chat-utils.js";

test("assemblePromptWithAttachments includes bounded attachment context", () => {
  const attachments = normalizePromptAttachments([
    {
      id: "a1",
      kind: "selection",
      label: "src/app.ts:1-2",
      path: "src/app.ts",
      range: "1:1-2:1",
      content: "const ok = true;"
    },
    {
      id: "bin",
      kind: "unsupported",
      label: "image.png"
    }
  ]);

  const prompt = assemblePromptWithAttachments("review this", attachments);
  assert.match(prompt, /Context attachments:/);
  assert.match(prompt, /src\/app\.ts:1-2/);
  assert.match(prompt, /const ok = true;/);
  assert.match(prompt, /User request:\nreview this/);
  assert.doesNotMatch(prompt, /image\.png\nContent/);
});

test("parseDiffProposals extracts safe fenced diffs and rejects unsafe paths", () => {
  const safe = parseDiffProposals("```diff\ndiff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n```");
  assert.equal(safe.length, 1);
  assert.deepEqual(safe[0].targetPaths, ["src/a.ts"]);
  assert.equal(safe[0].applicable, true);

  const unsafe = parseDiffProposals("```diff\n--- a/../../secret\n+++ b/../../secret\n@@\n-x\n+y\n```");
  assert.equal(unsafe[0].applicable, false);
});

test("buildTextDiff creates a preview for write requests", () => {
  const diff = buildTextDiff("old\n", "new\n", "src/file.ts");
  assert.match(diff, /--- a\/src\/file\.ts/);
  assert.match(diff, /\+new/);
});
