import assert from "node:assert/strict";
import test from "node:test";
import { filesMostRecentlyModifiedFirst } from "../src/recentChanges.ts";

test("orders changed files from most to least recently modified", () => {
  const files = [
    { path: "Sources/First.swift", modificationDate: "2026-07-25T17:00:00Z" },
    { path: "Sources/Latest.swift", modificationDate: "2026-07-25T18:30:00Z" },
    { path: "Sources/Middle.swift", modificationDate: "2026-07-25T18:00:00Z" },
  ];

  assert.deepEqual(
    filesMostRecentlyModifiedFirst(files).map((file) => file.path),
    ["Sources/Latest.swift", "Sources/Middle.swift", "Sources/First.swift"],
  );
});

test("places missing or invalid modification dates last with a stable path order", () => {
  const files = [
    { path: "z-deleted.swift" },
    { path: "Current.swift", modificationDate: "2026-07-25T18:30:00Z" },
    { path: "a-deleted.swift", modificationDate: "not-a-date" },
  ];

  assert.deepEqual(
    filesMostRecentlyModifiedFirst(files).map((file) => file.path),
    ["Current.swift", "a-deleted.swift", "z-deleted.swift"],
  );
});

test("does not mutate the natural file order", () => {
  const files = [
    { path: "A.swift", modificationDate: "2026-07-25T17:00:00Z" },
    { path: "B.swift", modificationDate: "2026-07-25T18:00:00Z" },
  ];

  filesMostRecentlyModifiedFirst(files);

  assert.deepEqual(files.map((file) => file.path), ["A.swift", "B.swift"]);
});
