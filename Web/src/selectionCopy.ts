import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from "@pierre/diffs";

type DiffSide = "deletions" | "additions";
type DiffRowKind = "context" | "deletion" | "addition";

type DiffLine = {
  side: DiffSide;
  lineNumber: number;
  text: string;
};

type DiffRow = {
  kind: DiffRowKind;
  deletion?: DiffLine;
  addition?: DiffLine;
};

type LineRange = {
  start: number;
  end: number;
};

type ReferenceTarget = {
  label?: string;
  path: string;
  ranges: LineRange[];
};

export type DiffSelectionCopyMode = "reference" | "reference-with-contents";

export function formatDiffSelection(
  fileDiff: FileDiffMetadata,
  selection: SelectedLineRange,
  mode: DiffSelectionCopyMode,
) {
  const rows = selectedRows(fileDiff, selection);

  if (rows.length === 0) {
    return undefined;
  }

  const reference = formatReference(fileDiff, rows);

  if (mode === "reference") {
    return reference;
  }

  return `${reference}\n\n${fencedBlock("diff", formatDiffContents(rows))}`;
}

function selectedRows(fileDiff: FileDiffMetadata, selection: SelectedLineRange) {
  const rows = diffRows(fileDiff);
  const startIndex = rowIndexForSelection(rows, selection.start, selection.side);
  const endIndex = rowIndexForSelection(rows, selection.end, selection.endSide ?? selection.side);

  if (startIndex === undefined || endIndex === undefined) {
    return [];
  }

  const first = Math.min(startIndex, endIndex);
  const last = Math.max(startIndex, endIndex);

  return rows.slice(first, last + 1);
}

function diffRows(fileDiff: FileDiffMetadata) {
  const rows: DiffRow[] = [];

  for (const hunk of fileDiff.hunks) {
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            kind: "context",
            deletion: {
              side: "deletions",
              lineNumber: deletionLineNumber,
              text: fileDiff.deletionLines[content.deletionLineIndex + offset] ?? "",
            },
            addition: {
              side: "additions",
              lineNumber: additionLineNumber,
              text: fileDiff.additionLines[content.additionLineIndex + offset] ?? "",
            },
          });

          deletionLineNumber += 1;
          additionLineNumber += 1;
        }
      } else {
        for (let offset = 0; offset < content.deletions; offset += 1) {
          rows.push({
            kind: "deletion",
            deletion: {
              side: "deletions",
              lineNumber: deletionLineNumber,
              text: fileDiff.deletionLines[content.deletionLineIndex + offset] ?? "",
            },
          });

          deletionLineNumber += 1;
        }

        for (let offset = 0; offset < content.additions; offset += 1) {
          rows.push({
            kind: "addition",
            addition: {
              side: "additions",
              lineNumber: additionLineNumber,
              text: fileDiff.additionLines[content.additionLineIndex + offset] ?? "",
            },
          });

          additionLineNumber += 1;
        }
      }
    }
  }

  return rows;
}

function rowIndexForSelection(rows: DiffRow[], lineNumber: number, side: SelectionSide = "additions") {
  const index = rows.findIndex((row) => {
    if (side === "deletions") {
      return row.deletion?.lineNumber === lineNumber;
    }

    return row.addition?.lineNumber === lineNumber;
  });

  return index < 0 ? undefined : index;
}

function formatReference(fileDiff: FileDiffMetadata, rows: DiffRow[]) {
  const targets = referenceTargets(fileDiff, rows);

  if (targets.length === 1) {
    return formatReferenceTarget(targets[0]);
  }

  return [
    `${normalizeDiffPath(fileDiff.name)} selection:`,
    ...targets.map((target) => `- ${target.label}: ${formatPathRanges(target.path, target.ranges)}`),
  ].join("\n");
}

function referenceTargets(fileDiff: FileDiffMetadata, rows: DiffRow[]): ReferenceTarget[] {
  const hasDeletionOnly = rows.some((row) => row.kind === "deletion");
  const hasAdditionOnly = rows.some((row) => row.kind === "addition");
  const oldPath = normalizeDiffPath(fileDiff.prevName ?? fileDiff.name);
  const newPath = normalizeDiffPath(fileDiff.name);

  if (hasDeletionOnly && hasAdditionOnly) {
    return [
      { label: "old", path: oldPath, ranges: lineRanges(rows.flatMap((row) => row.deletion?.lineNumber ?? [])) },
      { label: "new", path: newPath, ranges: lineRanges(rows.flatMap((row) => row.addition?.lineNumber ?? [])) },
    ].filter((target) => target.ranges.length > 0);
  }

  if (hasDeletionOnly) {
    return [{
      label: "old/deleted side",
      path: oldPath,
      ranges: lineRanges(rows.flatMap((row) => row.deletion?.lineNumber ?? [])),
    }];
  }

  return [{
    path: newPath,
    ranges: lineRanges(rows.flatMap((row) => row.addition?.lineNumber ?? [])),
  }];
}

function formatReferenceTarget(target: ReferenceTarget) {
  const reference = formatPathRanges(target.path, target.ranges);

  return target.label ? `${reference} (${target.label})` : reference;
}

function formatPathRanges(path: string, ranges: LineRange[]) {
  return `${path}:${ranges.map(formatLineRange).join(",")}`;
}

function lineRanges(lineNumbers: number[]) {
  const sorted = [...new Set(lineNumbers)]
    .filter((lineNumber) => Number.isFinite(lineNumber) && lineNumber > 0)
    .sort((a, b) => a - b);
  const ranges: LineRange[] = [];

  for (const lineNumber of sorted) {
    const previous = ranges.at(-1);

    if (previous && previous.end + 1 === lineNumber) {
      previous.end = lineNumber;
    } else {
      ranges.push({ start: lineNumber, end: lineNumber });
    }
  }

  return ranges;
}

function formatLineRange(range: LineRange) {
  return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
}

function formatDiffContents(rows: DiffRow[]) {
  return rows.map((row) => {
    switch (row.kind) {
      case "deletion":
        return `-${trimLineBreak(row.deletion?.text ?? "")}`;
      case "addition":
        return `+${trimLineBreak(row.addition?.text ?? "")}`;
      case "context":
        return ` ${trimLineBreak(row.addition?.text ?? row.deletion?.text ?? "")}`;
    }
  }).join("\n");
}

function fencedBlock(language: string, contents: string) {
  const longestFence = Math.max(2, ...Array.from(contents.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);

  return `${fence}${language}\n${contents}\n${fence}`;
}

function trimLineBreak(line: string) {
  return line.replace(/(?:\r\n|\n|\r)$/, "");
}

function normalizeDiffPath(path: string) {
  return path.replace(/^[ab]\//, "");
}
