import assert from "node:assert/strict";
import test from "node:test";
import { applyDiffFontFamily, fontFamilyStack, normalizedFontFamilies } from "../src/fontPreferences.ts";

test("normalizes discovered font families for the picker", () => {
  assert.deepEqual(normalizedFontFamilies(["Menlo", " Monaco ", "Menlo", ""]), ["Menlo", "Monaco"]);
});

test("quotes a selected font family for use in CSS", () => {
  assert.equal(
    fontFamilyStack('A "Quoted" Font'),
    '"A \\"Quoted\\" Font", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
  );
});

test("uses the system monospace stack when no family is selected", () => {
  assert.equal(fontFamilyStack(""), 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace');
});

test("applies the selected family only through Pierre's diff font property", () => {
  const properties = new Map<string, string>();
  const style = {
    setProperty(name: string, value: string) {
      properties.set(name, value);
    },
    removeProperty(name: string) {
      const previous = properties.get(name) ?? "";
      properties.delete(name);
      return previous;
    },
  };

  applyDiffFontFamily(style, "Andale Mono");

  assert.deepEqual([...properties], [
    ["--diffs-font-family", '"Andale Mono", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace'],
  ]);

  applyDiffFontFamily(style, "");
  assert.equal(properties.size, 0);
});
