export type ModificationDatedFile = {
  path: string;
  modificationDate?: string;
};

export function filesMostRecentlyModifiedFirst<T extends ModificationDatedFile>(files: readonly T[]): T[] {
  return [...files].sort((left, right) => {
    const leftTime = modificationTime(left.modificationDate);
    const rightTime = modificationTime(right.modificationDate);

    if (leftTime !== rightTime) {
      return rightTime > leftTime ? 1 : -1;
    }

    return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
  });
}

function modificationTime(value: string | undefined) {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : Number.NEGATIVE_INFINITY;
}
