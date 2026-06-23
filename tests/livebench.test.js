import test from "node:test";
import assert from "node:assert/strict";
import { inferLiveBenchCategory, parseLiveBenchData } from "../dist/livebench.js";

test("LiveBench parser computes category and global averages", () => {
  const data = parseLiveBenchData(
    "2026-01-08",
    [
      "model,code_generation,code_completion,tablejoin,tablereformat",
      "cheap,80,70,20,40",
      "strong,95,85,60,80"
    ].join("\n"),
    JSON.stringify({
      Coding: ["code_generation", "code_completion"],
      "Data Analysis": ["tablejoin", "tablereformat"]
    })
  );

  assert.equal(data.models.size, 2);
  assert.equal(data.models.get("cheap").categoryScores.Coding, 75);
  assert.equal(data.models.get("strong").categoryScores["Data Analysis"], 70);
  assert.equal(data.models.get("strong").globalScore, 80);
});

test("LiveBench category inference routes common coding and data prompts", () => {
  assert.equal(inferLiveBenchCategory("Implement a TypeScript parser and add tests", [], "agent"), "Coding");
  assert.equal(inferLiveBenchCategory("Analyze this CSV dataset and build a chart", [], "agent"), "Data Analysis");
  assert.equal(inferLiveBenchCategory("Plan a multi-step refactor across the repo", [], "plan"), "Agentic Coding");
});
