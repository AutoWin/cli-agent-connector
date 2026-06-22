import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { JsonRpcPeer } from "../dist/jsonrpc.js";

test("JsonRpcPeer handles requests and notifications over JSON lines", async () => {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new JsonRpcPeer(bToA, aToB);
  const b = new JsonRpcPeer(aToB, bToA);
  let notified = false;

  b.onRequest("math/add", (params) => {
    return params.a + params.b;
  });
  b.onNotification("note", () => {
    notified = true;
  });
  a.start();
  b.start();

  const result = await a.request("math/add", { a: 2, b: 3 });
  a.notify("note", {});
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(result, 5);
  assert.equal(notified, true);
});
