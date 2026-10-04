import test from "node:test";
import assert from "node:assert/strict";
import { label } from "./client.mjs";
test("shows requestId", () => assert.equal(label({ message: "ok", requestId: "req-7" }), "ok (req-7)"));
