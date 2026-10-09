import test from "node:test";
import assert from "node:assert/strict";
import { incrementWithinLimit } from "./counter.mjs";
test("increments below the limit", () => assert.equal(incrementWithinLimit(2, 5), 3));
test("does not cross the limit", () => assert.equal(incrementWithinLimit(5, 5), 5));
