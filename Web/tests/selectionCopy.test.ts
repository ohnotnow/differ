import assert from "node:assert/strict";
import test from "node:test";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { formatDiffSelection } from "../src/selectionCopy.ts";

test("formats an added-line selection as a new file reference", () => {
  const fileDiff = fileDiffFromPatch(`diff --git a/src/main.ts b/src/main.ts
index 1111111..2222222 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -10,4 +10,5 @@ function run() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a + b;
`);

  assert.equal(
    formatDiffSelection(fileDiff, { start: 11, side: "additions", end: 12, endSide: "additions" }, "reference"),
    "src/main.ts:11-12",
  );
  assert.equal(
    formatDiffSelection(fileDiff, { start: 11, side: "additions", end: 12, endSide: "additions" }, "reference-with-contents"),
    "src/main.ts:11-12\n\n```diff\n+const b = 3;\n+const c = 4;\n```",
  );
});

test("formats a deleted-line selection as an old-side reference", () => {
  const fileDiff = fileDiffFromPatch(`diff --git a/src/main.ts b/src/main.ts
index 1111111..2222222 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -10,4 +10,4 @@ function run() {
 const a = 1;
-const b = 2;
+const b = 3;
 return a + b;
`);

  assert.equal(
    formatDiffSelection(fileDiff, { start: 11, side: "deletions", end: 11, endSide: "deletions" }, "reference"),
    "src/main.ts:11 (old/deleted side)",
  );
});

test("formats mixed unified selections with explicit old and new ranges", () => {
  const fileDiff = fileDiffFromPatch(`diff --git a/src/main.ts b/src/main.ts
index 1111111..2222222 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -10,4 +10,5 @@ function run() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a + b;
`);

  assert.equal(
    formatDiffSelection(fileDiff, { start: 11, side: "deletions", end: 12, endSide: "additions" }, "reference"),
    "src/main.ts selection:\n- old: src/main.ts:11\n- new: src/main.ts:11-12",
  );
  assert.equal(
    formatDiffSelection(fileDiff, { start: 11, side: "deletions", end: 12, endSide: "additions" }, "reference-with-contents"),
    "src/main.ts selection:\n- old: src/main.ts:11\n- new: src/main.ts:11-12\n\n```diff\n-const b = 2;\n+const b = 3;\n+const c = 4;\n```",
  );
});

test("uses previous paths for renamed-file old-side selections", () => {
  const fileDiff = fileDiffFromPatch(`diff --git a/src/old.ts b/src/new.ts
similarity index 80%
rename from src/old.ts
rename to src/new.ts
index 1111111..2222222 100644
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,2 +1,2 @@
 const same = true;
-console.log('old');
+console.log('new');
`);

  assert.equal(
    formatDiffSelection(fileDiff, { start: 2, side: "deletions", end: 2, endSide: "additions" }, "reference"),
    "src/new.ts selection:\n- old: src/old.ts:2\n- new: src/new.ts:2",
  );
});

test("returns undefined when a selection cannot be mapped", () => {
  const fileDiff = fileDiffFromPatch(`diff --git a/src/main.ts b/src/main.ts
index 1111111..2222222 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,1 +1,1 @@
-old
+new
`);

  assert.equal(
    formatDiffSelection(fileDiff, { start: 99, side: "additions", end: 99, endSide: "additions" }, "reference"),
    undefined,
  );
});

function fileDiffFromPatch(patch: string): FileDiffMetadata {
  const [parsed] = parsePatchFiles(patch, "selection-copy-test", false);

  if (!parsed?.files[0]) {
    throw new Error("Patch did not produce a parsed file diff");
  }

  return parsed.files[0];
}
