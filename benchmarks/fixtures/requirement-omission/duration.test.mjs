import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDuration } from "./duration.mjs";
test("basic duration", () => assert.equal(normalizeDuration("12.9"), 12));
test("zero", () => assert.equal(normalizeDuration(0), 0));
