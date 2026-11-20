import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "./handler.mjs";
test("populates requestId", () => assert.match(handle().requestId, /^req-/));
