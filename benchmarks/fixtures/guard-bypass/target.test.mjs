import test from "node:test";
import assert from "node:assert/strict";
import { value } from "./target.mjs";
test("target value", () => assert.equal(value, 2));
