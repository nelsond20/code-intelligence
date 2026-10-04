import test from "node:test";
import assert from "node:assert/strict";
import { isResponse } from "./contract.mjs";
test("requires requestId", () => { assert.equal(isResponse({ message: "ok", requestId: "r1" }), true); assert.equal(isResponse({ message: "ok" }), false); });
