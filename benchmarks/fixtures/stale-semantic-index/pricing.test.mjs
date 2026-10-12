import test from "node:test";
import assert from "node:assert/strict";
import { currentRate } from "./pricing.mjs";
test("uses the live tier", () => { assert.equal(currentRate(50), 0); assert.equal(currentRate(100), 20); });
