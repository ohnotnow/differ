import { File as FileView, FileDiff, parsePatchFiles, type FileContents, type FileDiffMetadata } from "@pierre/diffs";
import { FileTree, type GitStatusEntry } from "@pierre/trees";
import "./styles.css";

type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "ignored" | "conflicted" | "mixed";

type ChangedFile = {
  path: string;
  oldPath?: string;
  status: FileStatus;
  indexStatus?: string;
  workTreeStatus?: string;
  contents?: string;
};

type DifferSnapshot = {
  repositoryPath: string;
  files: ChangedFile[];
  allPatch: string;
  generatedAt: string;
};

type DifferPreferences = {
  refreshIntervalMilliseconds: number;
};

type NativeMessage =
  | { type: "select-file"; path: string }
  | { type: "select-all" }
  | { type: "manual-refresh" }
  | { type: "set-refresh-interval"; milliseconds: number }
  | { type: "web-ready" };

declare global {
  interface Window {
    Differ?: {
      applySnapshot: (snapshot: DifferSnapshot) => void;
      applyPatch: (path: string, patch: string) => void;
      applyPreferences: (preferences: DifferPreferences) => void;
    };
    webkit?: {
      messageHandlers?: {
        differ?: {
          postMessage: (message: NativeMessage) => void;
        };
      };
    };
  }
}

const diffHost = mustFind<HTMLElement>("#diff-host");
const fallbackFiles = mustFind<HTMLElement>("#fallback-files");
const changeCount = mustFind<HTMLElement>("#change-count");
const selectionTitle = mustFind<HTMLElement>("#selection-title");
const manualRefresh = mustFind<HTMLButtonElement>("#manual-refresh");
const refreshInterval = mustFind<HTMLSelectElement>("#refresh-interval");
const treeHost = mustFind<HTMLElement>("#tree-host");

const emptySnapshot: DifferSnapshot = {
  repositoryPath: "",
  generatedAt: new Date(0).toISOString(),
  files: [],
  allPatch: "",
};

let snapshot = emptySnapshot;
let hasNativeSnapshot = false;
let selectedPath: string | null = null;
let allDiffFiles: FileDiffMetadata[] = [];
let currentDiffFiles = allDiffFiles;

let tree: FileTree | null = null;
let syncingTreeSelection = false;
let treeSyncGeneration = 0;
let renderedTreeDataKey: string | null = null;
let renderedViews: Array<{ cleanUp: () => void }> = [];

function render() {
  changeCount.textContent = hasNativeSnapshot
    ? `${snapshot.files.length} ${snapshot.files.length === 1 ? "change" : "changes"}`
    : "Waiting";
  selectionTitle.textContent = hasNativeSnapshot ? selectedPath ?? "All changes" : "Waiting for repository snapshot";

  renderFallbackFiles();
  renderTree();
  renderDiff(currentDiffFiles);
}

function renderFallbackFiles() {
  fallbackFiles.replaceChildren();

  if (!hasNativeSnapshot || snapshot.files.length === 0) {
    return;
  }

  fallbackFiles.append(fileButton({ path: "All changes", status: "mixed" }, selectedPath === null, () => selectAllChanges()));

  for (const file of snapshot.files) {
    fallbackFiles.append(fileButton(file, selectedPath === file.path, () => selectPath(file.path)));
  }
}

function fileButton(file: Pick<ChangedFile, "path" | "status">, selected: boolean, onClick: () => void) {
  const button = document.createElement("button");
  button.className = selected ? "file-row selected" : "file-row";
  button.type = "button";
  button.title = file.path === "All changes" ? "All changed files" : `${statusTitle(file.status)}: ${file.path}`;
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", onClick);

  const badge = document.createElement("span");
  badge.className = `status-badge ${file.status}`;
  badge.textContent = statusLabel(file.status);
  badge.title = statusTitle(file.status);
  badge.setAttribute("aria-label", statusTitle(file.status));

  const path = document.createElement("span");
  path.className = "file-path";
  path.textContent = file.path;
  path.title = file.path;

  button.append(badge, path);
  return button;
}

function selectAllChanges(notifyNative = true) {
  selectedPath = null;
  currentDiffFiles = allDiffFiles;

  if (notifyNative) {
    postNative({ type: "select-all" });
  }

  render();
}

function selectPath(path: string, notifyNative = true) {
  const file = fileForPath(path);

  if (!file) {
    return;
  }

  selectedPath = path;
  currentDiffFiles = allDiffFiles.filter((fileDiff) => diffMatchesChangedFile(fileDiff, file));
  if (notifyNative) {
    postNative({ type: "select-file", path });
  }

  render();
}

function renderTree() {
  if (!hasNativeSnapshot || snapshot.files.length === 0) {
    if (tree) {
      tree.cleanUp();
      tree = null;
      renderedTreeDataKey = null;
    }

    treeHost.replaceChildren();
    return;
  }

  if (!tree) {
    tree = new FileTree({
      paths: snapshot.files.map((file) => file.path),
      initialExpansion: "open",
      initialSelectedPaths: selectedPath ? [selectedPath] : [],
      gitStatus: gitStatusEntries(),
      icons: { set: "minimal", colored: false },
      renderRowDecoration({ item }) {
        const file = fileForPath(item.path);

        if (!file) {
          return null;
        }

        return { text: statusLabel(file.status), title: statusTitle(file.status) };
      },
      onSelectionChange(paths) {
        if (syncingTreeSelection) {
          return;
        }

        const [path] = paths;

        if (!path || path === selectedPath || !fileForPath(path)) {
          return;
        }

        selectPath(path);
      },
    });

    tree.render({ fileTreeContainer: treeHost });
    renderedTreeDataKey = treeDataKey();
    return;
  }

  const nextTreeDataKey = treeDataKey();

  if (renderedTreeDataKey !== nextTreeDataKey) {
    syncTreeSelection(() => {
      tree?.resetPaths(snapshot.files.map((file) => file.path));
      tree?.setGitStatus(gitStatusEntries());
    });
    renderedTreeDataKey = nextTreeDataKey;
  }

  syncCurrentTreeSelection();
}

function syncCurrentTreeSelection() {
  syncTreeSelection(() => {
    for (const file of snapshot.files) {
      const item = tree?.getItem(file.path);

      if (file.path === selectedPath) {
        item?.select();
      } else {
        item?.deselect();
      }
    }
  });
}

function treeDataKey() {
  return snapshot.files
    .map((file) => `${file.path}\0${file.oldPath ?? ""}\0${file.status}\0${file.indexStatus}\0${file.workTreeStatus}`)
    .join("\n");
}

function syncTreeSelection(callback: () => void) {
  syncingTreeSelection = true;
  treeSyncGeneration += 1;
  const generation = treeSyncGeneration;

  try {
    callback();
  } finally {
    window.setTimeout(() => {
      if (treeSyncGeneration === generation) {
        syncingTreeSelection = false;
      }
    }, 0);
  }
}

function renderDiff(fileDiffs: FileDiffMetadata[]) {
  cleanRenderedViews();
  diffHost.replaceChildren();

  if (!hasNativeSnapshot) {
    diffHost.append(emptyState("Waiting for repository snapshot"));
    return;
  }

  if (snapshot.files.length === 0) {
    diffHost.append(emptyState("No changes"));
    return;
  }

  const missingFiles = missingDiffFiles(fileDiffs);

  if (fileDiffs.length === 0 && missingFiles.length === 0) {
    diffHost.append(emptyState("No diff to show"));
    return;
  }

  for (const fileDiff of fileDiffs) {
    const frame = document.createElement("section");
    frame.className = "file-diff-frame";
    diffHost.append(frame);

    const view = new FileDiff({
      theme: "pierre-dark",
      diffStyle: "unified",
      hunkSeparators: "line-info-basic",
      overflow: "scroll",
    });

    renderedViews.push(view);
    view.render({
      fileDiff,
      containerWrapper: frame,
    });
  }

  for (const file of missingFiles) {
    if (shouldRenderContentPreview(file)) {
      renderFilePreview(file);
    } else {
      diffHost.append(diffNotice(file));
    }
  }
}

function emptyState(message: string) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function cleanRenderedViews() {
  for (const view of renderedViews) {
    view.cleanUp();
  }

  renderedViews = [];
}

function missingDiffFiles(fileDiffs: FileDiffMetadata[]) {
  const candidates = selectedPath ? snapshot.files.filter((file) => file.path === selectedPath) : snapshot.files;

  return candidates.filter((file) => !fileDiffs.some((fileDiff) => diffMatchesChangedFile(fileDiff, file)));
}

function diffNotice(file: ChangedFile) {
  const notice = document.createElement("section");
  notice.className = "diff-notice";

  const badge = document.createElement("span");
  badge.className = `status-badge ${file.status}`;
  badge.textContent = statusLabel(file.status);
  badge.title = statusTitle(file.status);

  const copy = document.createElement("div");

  const title = document.createElement("strong");
  title.className = "diff-notice-title";
  title.textContent = file.path;

  const detail = document.createElement("p");
  detail.className = "diff-notice-detail";
  detail.textContent = noDiffMessage(file);

  copy.append(title, detail);
  notice.append(badge, copy);

  return notice;
}

function shouldRenderContentPreview(file: ChangedFile) {
  return (file.status === "added" || file.status === "untracked") && file.contents !== undefined;
}

function renderFilePreview(file: ChangedFile) {
  const frame = document.createElement("section");
  frame.className = "file-preview-frame";
  diffHost.append(frame);

  const fileContents: FileContents = {
    name: file.path,
    contents: file.contents ?? "",
    cacheKey: `${snapshot.generatedAt}:${file.path}:contents`,
  };

  const view = new FileView({
    theme: "pierre-dark",
    overflow: "scroll",
  });

  renderedViews.push(view);
  view.render({
    file: fileContents,
    containerWrapper: frame,
  });
}

function patchFiles(patch: string): FileDiffMetadata[] {
  try {
    return parsePatchFiles(patch, "differ-preview", false).flatMap((parsed) => parsed.files);
  } catch (error) {
    console.error("Could not parse patch", error);
    return [];
  }
}

function diffMatchesChangedFile(fileDiff: FileDiffMetadata, file: ChangedFile) {
  const diffPaths = [fileDiff.name, fileDiff.prevName].flatMap((path) => normalizedDiffPath(path));
  const filePaths = [file.path, file.oldPath].flatMap((path) => normalizedDiffPath(path));

  return filePaths.some((path) => diffPaths.includes(path));
}

function normalizedDiffPath(path: string | undefined) {
  if (!path) {
    return [];
  }

  return [path, path.replace(/^[ab]\//, "")];
}

function fileForPath(path: string) {
  return snapshot.files.find((file) => file.path === path);
}

function gitStatusEntries(): GitStatusEntry[] {
  return snapshot.files.map((file) => ({
    path: file.path,
    status: treeStatus(file.status),
  }));
}

function treeStatus(status: FileStatus): GitStatusEntry["status"] {
  switch (status) {
    case "added":
    case "deleted":
    case "ignored":
    case "modified":
    case "renamed":
    case "untracked":
      return status;
    case "copied":
    case "conflicted":
    case "mixed":
      return "modified";
  }
}

function statusLabel(status: FileStatus) {
  const labels: Record<FileStatus, string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    copied: "C",
    untracked: "U",
    ignored: "I",
    conflicted: "!",
    mixed: "*",
  };

  return labels[status];
}

function statusTitle(status: FileStatus) {
  const titles: Record<FileStatus, string> = {
    added: "Added",
    modified: "Modified",
    deleted: "Deleted",
    renamed: "Renamed",
    copied: "Copied",
    untracked: "Untracked",
    ignored: "Ignored",
    conflicted: "Conflicted",
    mixed: "Mixed staged and unstaged changes",
  };

  return titles[status];
}

function noDiffMessage(file: ChangedFile) {
  switch (file.status) {
    case "added":
    case "untracked":
      return "Git reports this file as new, but there is no parsed text hunk or previewable UTF-8 content to render. It may be binary, generated, or too large.";
    case "deleted":
      return "Git reports this file as deleted, but there is no parsed text hunk to render.";
    default:
      return "Git reports a change, but there is no parsed text hunk to render. This is often a binary, mode-only, or generated-file change.";
  }
}

function postNative(message: NativeMessage) {
  window.webkit?.messageHandlers?.differ?.postMessage(message);
}

function mustFind<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

manualRefresh.addEventListener("click", () => {
  postNative({ type: "manual-refresh" });
});

refreshInterval.addEventListener("change", () => {
  postNative({
    type: "set-refresh-interval",
    milliseconds: Number.parseInt(refreshInterval.value, 10),
  });
});

window.Differ = {
  applySnapshot(nextSnapshot) {
    const previousPath = selectedPath;
    hasNativeSnapshot = true;
    snapshot = nextSnapshot;
    allDiffFiles = patchFiles(nextSnapshot.allPatch);

    if (previousPath && fileForPath(previousPath)) {
      selectPath(previousPath, false);
    } else {
      selectAllChanges(false);
    }
  },
  applyPatch(path, patch) {
    if (selectedPath !== path) {
      return;
    }

    selectedPath = path;
    currentDiffFiles = patchFiles(patch);
    render();
  },
  applyPreferences(preferences) {
    refreshInterval.value = `${preferences.refreshIntervalMilliseconds}`;
  },
};

render();
postNative({ type: "web-ready" });
