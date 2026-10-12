import test from "node:test";
import assert from "node:assert/strict";
import { parseQuantity } from "./parser.mjs";
test("parses grouped quantities", () => assert.equal(parseQuantity("1,250"), 1250));
