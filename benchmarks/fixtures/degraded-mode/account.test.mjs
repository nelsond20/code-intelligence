import test from "node:test";
import assert from "node:assert/strict";
import { formatAccountId } from "./account.mjs";
test("formats account IDs", () => assert.equal(formatAccountId("acct", 7), "ACCT-7"));
