import test from "node:test";
import assert from "node:assert/strict";
import { resumeToken } from "./session.mjs";
test("prefixes resumed tokens", () => assert.equal(resumeToken("abc"), "resume:abc"));
