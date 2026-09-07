import test from "node:test";
import assert from "node:assert/strict";
import { terminalFontStack } from "./fontStack.ts";

test("missing preferred Latin font falls back to monospace before CJK", () => {
  const stack = terminalFontStack({ fontFamilyLatin: "Missing Font", fontFamilyCjk: "Microsoft YaHei" });
  assert.equal(stack, '"Missing Font", "Consolas", "Courier New", "Microsoft YaHei", monospace');
});

test("font stack preserves chosen fonts and escapes CSS strings", () => {
  const stack = terminalFontStack({ fontFamilyLatin: 'Font"Name', fontFamilyCjk: "CJK" });
  assert.ok(stack.startsWith('"Font\\"Name",'));
  assert.ok(stack.includes('"CJK"'));
});
