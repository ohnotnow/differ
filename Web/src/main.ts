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
  autoRefreshEnabled: boolean;
  uiZoomPercent: number;
  sidebarWidthPoints: number;
};

type NativeMessage =
  | { type: "select-file"; path: string }
  | { type: "select-all" }
  | { type: "set-auto-refresh"; enabled: boolean }
  | { type: "set-refresh-interval"; milliseconds: number }
  | { type: "set-ui-zoom"; percent: number }
  | { type: "set-sidebar-width"; points: number }
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
const autoRefresh = mustFind<HTMLButtonElement>("#auto-refresh");
const refreshInterval = mustFind<HTMLSelectElement>("#refresh-interval");
const treeHost = mustFind<HTMLElement>("#tree-host");
const zoomIn = mustFind<HTMLButtonElement>("#zoom-in");
const zoomOut = mustFind<HTMLButtonElement>("#zoom-out");
const zoomSelect = mustFind<HTMLSelectElement>("#zoom-select");
const appShell = mustFind<HTMLElement>("#app");
const panelResizer = mustFind<HTMLElement>("#panel-resizer");

const defaultZoomPercent = 100;
const minimumZoomPercent = 80;
const maximumZoomPercent = 200;
const zoomStepPercent = 10;

const defaultSidebarWidthPoints = 300;
const minimumSidebarWidthPoints = 140;
const maximumSidebarWidthPoints = 2000;
const sidebarKeyboardStepPoints = 16;
const reservedDiffRem = 18;

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
let renderedFileListKey: string | null = null;
const fileRowCache = new Map<string, HTMLButtonElement>();
const focusedPatchCache = new Map<string, FileDiffMetadata[]>();
let syncingTreeSelection = false;
let treeSyncGeneration = 0;
let renderedTreeDataKey: string | null = null;
let renderedViews: Array<{ cleanUp: () => void }> = [];
let uiZoomPercent = defaultZoomPercent;
let sidebarWidthPoints = defaultSidebarWidthPoints;
let autoRefreshEnabled = true;
let pendingAutoRefreshEnabled: boolean | null = null;
let zoomReflowFrame: number | null = null;

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
  if (!hasNativeSnapshot || snapshot.files.length === 0) {
    clearFallbackFiles();
    return;
  }

  const nextFileListKey = fileListKey();
  const needsStructureSync = renderedFileListKey !== nextFileListKey;

  if (needsStructureSync) {
    const retainedKeys = new Set(["__all__", ...snapshot.files.map((file) => file.path)]);

    for (const [key, button] of fileRowCache) {
      if (!retainedKeys.has(key)) {
        button.remove();
        fileRowCache.delete(key);
      }
    }
  }

  if (needsStructureSync) {
    const fragment = document.createDocumentFragment();
    fragment.append(buttonForFileRow("__all__", { path: "All changes", status: "mixed" }, selectedPath === null));

    for (const file of snapshot.files) {
      fragment.append(buttonForFileRow(file.path, file, selectedPath === file.path));
    }

    const scrollTop = fallbackFiles.scrollTop;
    fallbackFiles.append(fragment);
    fallbackFiles.scrollTop = scrollTop;
    renderedFileListKey = nextFileListKey;
    return;
  }

  const allChangesRow = fileRowCache.get("__all__");
  if (allChangesRow) {
    updateFileButton(allChangesRow, { path: "All changes", status: "mixed" }, selectedPath === null);
  }

  for (const file of snapshot.files) {
    const button = fileRowCache.get(file.path);
    if (button) {
      updateFileButton(button, file, selectedPath === file.path);
    }
  }
  syncFileRowSelection();
}

function fileListKey() {
  return snapshot.files
    .map((file) => `${file.path}\0${file.oldPath ?? ""}\0${file.status}\0${file.indexStatus}\0${file.workTreeStatus}`)
    .join("\n");
}

function clearFallbackFiles() {
  fileRowCache.clear();
  renderedFileListKey = null;
  fallbackFiles.replaceChildren();
}

function buttonForFileRow(key: string, file: Pick<ChangedFile, "path" | "status">, selected: boolean) {
  let button = fileRowCache.get(key);

  if (!button) {
    button = createFileButton(file, () => {
      if (key === "__all__") {
        selectAllChanges();
        return;
      }

      selectPath(key);
    });
    fileRowCache.set(key, button);
  }

  updateFileButton(button, file, selected);
  return button;
}

function createFileButton(file: Pick<ChangedFile, "path" | "status">, onClick: () => void) {
  const button = document.createElement("button");
  button.className = "file-row";
  button.type = "button";
  button.addEventListener("click", onClick);

  const badge = document.createElement("span");
  badge.className = "status-badge";

  const path = document.createElement("span");
  path.className = "file-path";

  button.append(badge, path);
  updateFileButton(button, file, false);
  return button;
}

function updateFileButton(button: HTMLButtonElement, file: Pick<ChangedFile, "path" | "status">, selected: boolean) {
  const title = file.path === "All changes" ? "All changed files" : `${statusTitle(file.status)}: ${file.path}`;
  const badge = button.querySelector<HTMLElement>(".status-badge");
  const path = button.querySelector<HTMLElement>(".file-path");

  button.classList.toggle("selected", selected);
  button.title = title;
  button.setAttribute("aria-label", title);

  if (badge) {
    badge.className = `status-badge ${file.status}`;
    badge.textContent = statusLabel(file.status);
    badge.title = statusTitle(file.status);
    badge.setAttribute("aria-label", statusTitle(file.status));
  }

  if (path) {
    path.textContent = file.path;
    path.title = file.path;
  }
}

function syncFileRowSelection() {
  fileRowCache.get("__all__")?.classList.toggle("selected", selectedPath === null);

  for (const file of snapshot.files) {
    fileRowCache.get(file.path)?.classList.toggle("selected", selectedPath === file.path);
  }
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
  currentDiffFiles = focusedPatchCache.get(path) ?? diffFilesForChangedFile(file);
  if (notifyNative) {
    postNative({ type: "select-file", path });
  }

  render();
}

function diffFilesForChangedFile(file: ChangedFile) {
  return allDiffFiles.filter((fileDiff) => diffMatchesChangedFile(fileDiff, file));
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
      itemHeight: treeItemHeight(),
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

function diffFilesSignature(fileDiffs: FileDiffMetadata[]) {
  try {
    return JSON.stringify(fileDiffs);
  } catch {
    return fileDiffs.map((fileDiff) => `${fileDiff.prevName ?? ""}\0${fileDiff.name ?? ""}`).join("\n");
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

function setAutoRefreshEnabled(enabled: boolean, notifyNative = true) {
  autoRefreshEnabled = enabled;
  autoRefresh.setAttribute("aria-pressed", `${enabled}`);
  autoRefresh.title = enabled ? "Turn off auto-refresh" : "Turn on auto-refresh";
  autoRefresh.setAttribute("aria-label", enabled ? "Turn off auto-refresh" : "Turn on auto-refresh");

  if (notifyNative) {
    pendingAutoRefreshEnabled = enabled;
    postNative({ type: "set-auto-refresh", enabled });
  }
}

function applyAutoRefreshPreference(enabled: boolean) {
  if (pendingAutoRefreshEnabled !== null) {
    if (enabled !== pendingAutoRefreshEnabled) {
      return;
    }

    pendingAutoRefreshEnabled = null;
  }

  setAutoRefreshEnabled(enabled, false);
}

function setUiZoomPercent(percent: number, notifyNative = true) {
  const nextZoomPercent = clampZoomPercent(percent);
  const didChange = nextZoomPercent !== uiZoomPercent;

  uiZoomPercent = nextZoomPercent;
  document.documentElement.style.setProperty("--ui-scale", `${nextZoomPercent / 100}`);
  zoomSelect.value = `${nextZoomPercent}`;
  zoomOut.disabled = nextZoomPercent <= minimumZoomPercent;
  zoomIn.disabled = nextZoomPercent >= maximumZoomPercent;

  if (didChange) {
    scheduleZoomReflow();
  }

  if (notifyNative) {
    postNative({ type: "set-ui-zoom", percent: nextZoomPercent });
  }
}

function scheduleZoomReflow() {
  if (zoomReflowFrame !== null) {
    window.cancelAnimationFrame(zoomReflowFrame);
  }

  const scrollProgress = diffScrollProgress();
  zoomReflowFrame = window.requestAnimationFrame(() => {
    zoomReflowFrame = null;
    rebuildTreeForZoom();
    renderDiff(currentDiffFiles);

    window.requestAnimationFrame(() => {
      restoreDiffScrollProgress(scrollProgress);
    });
  });
}

function rebuildTreeForZoom() {
  if (!tree) {
    return;
  }

  tree.cleanUp();
  tree = null;
  renderedTreeDataKey = null;
  treeHost.replaceChildren();
  renderTree();
}

function treeItemHeight() {
  return Math.round(30 * (uiZoomPercent / 100));
}

function diffScrollProgress() {
  const scrollRange = diffHost.scrollHeight - diffHost.clientHeight;

  if (scrollRange <= 0) {
    return 0;
  }

  return diffHost.scrollTop / scrollRange;
}

function restoreDiffScrollProgress(progress: number) {
  const scrollRange = diffHost.scrollHeight - diffHost.clientHeight;
  diffHost.scrollTop = scrollRange <= 0 ? 0 : progress * scrollRange;
}

function clampZoomPercent(percent: number) {
  if (!Number.isFinite(percent)) {
    return defaultZoomPercent;
  }

  return Math.min(maximumZoomPercent, Math.max(minimumZoomPercent, Math.round(percent / zoomStepPercent) * zoomStepPercent));
}

function setSidebarWidthPoints(points: number, notifyNative = true) {
  const nextPoints = clampSidebarWidthPoints(points);
  const didChange = nextPoints !== sidebarWidthPoints;

  sidebarWidthPoints = nextPoints;
  document.documentElement.style.setProperty("--sidebar-width-base", `${nextPoints}px`);

  if (notifyNative && didChange) {
    postNative({ type: "set-sidebar-width", points: nextPoints });
  }
}

function clampSidebarWidthPoints(points: number) {
  if (!Number.isFinite(points)) {
    return defaultSidebarWidthPoints;
  }

  const scale = uiZoomPercent / 100;
  const container = appShell.clientWidth || window.innerWidth;
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 13 * scale;

  const minRendered = minimumSidebarWidthPoints * scale;
  const maxRendered = Math.max(minRendered, container - reservedDiffRem * rootFontSize);
  const rendered = Math.min(maxRendered, Math.max(minRendered, points * scale));
  const logical = Math.round(rendered / scale);

  return Math.min(maximumSidebarWidthPoints, Math.max(minimumSidebarWidthPoints, logical));
}

function mustFind<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

autoRefresh.addEventListener("click", () => {
  setAutoRefreshEnabled(!autoRefreshEnabled);
});

refreshInterval.addEventListener("change", () => {
  postNative({
    type: "set-refresh-interval",
    milliseconds: Number.parseInt(refreshInterval.value, 10),
  });
});

zoomOut.addEventListener("click", () => {
  setUiZoomPercent(uiZoomPercent - zoomStepPercent);
});

zoomIn.addEventListener("click", () => {
  setUiZoomPercent(uiZoomPercent + zoomStepPercent);
});

zoomSelect.addEventListener("input", () => {
  setUiZoomPercent(Number.parseInt(zoomSelect.value, 10));
});

zoomSelect.addEventListener("change", () => {
  setUiZoomPercent(Number.parseInt(zoomSelect.value, 10));
});

panelResizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  panelResizer.setPointerCapture(event.pointerId);
  appShell.classList.add("resizing");

  const onMove = (moveEvent: PointerEvent) => {
    const scale = uiZoomPercent / 100;
    const shellLeft = appShell.getBoundingClientRect().left;
    setSidebarWidthPoints((moveEvent.clientX - shellLeft) / scale, false);
  };

  const onRelease = (releaseEvent: PointerEvent) => {
    panelResizer.releasePointerCapture(releaseEvent.pointerId);
    appShell.classList.remove("resizing");
    panelResizer.removeEventListener("pointermove", onMove);
    panelResizer.removeEventListener("pointerup", onRelease);
    panelResizer.removeEventListener("pointercancel", onRelease);
    postNative({ type: "set-sidebar-width", points: sidebarWidthPoints });
  };

  panelResizer.addEventListener("pointermove", onMove);
  panelResizer.addEventListener("pointerup", onRelease);
  panelResizer.addEventListener("pointercancel", onRelease);
});

panelResizer.addEventListener("dblclick", () => {
  setSidebarWidthPoints(defaultSidebarWidthPoints);
});

panelResizer.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setSidebarWidthPoints(sidebarWidthPoints - sidebarKeyboardStepPoints);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    setSidebarWidthPoints(sidebarWidthPoints + sidebarKeyboardStepPoints);
  }
});

window.addEventListener("keydown", (event) => {
  if (!event.metaKey && !event.ctrlKey) {
    return;
  }

  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    setUiZoomPercent(uiZoomPercent + zoomStepPercent);
    return;
  }

  if (event.key === "-") {
    event.preventDefault();
    setUiZoomPercent(uiZoomPercent - zoomStepPercent);
    return;
  }

  if (event.key === "0") {
    event.preventDefault();
    setUiZoomPercent(defaultZoomPercent);
  }
});

window.Differ = {
  applySnapshot(nextSnapshot) {
    const previousPath = selectedPath;
    const previousFocusedDiff = previousPath ? focusedPatchCache.get(previousPath) : undefined;

    focusedPatchCache.clear();
    hasNativeSnapshot = true;
    snapshot = nextSnapshot;
    allDiffFiles = patchFiles(nextSnapshot.allPatch);

    const previousFile = previousPath ? fileForPath(previousPath) : undefined;
    if (previousPath && previousFile) {
      const nextGlobalDiff = diffFilesForChangedFile(previousFile);
      if (previousFocusedDiff && nextGlobalDiff.length === 0) {
        focusedPatchCache.set(previousPath, previousFocusedDiff);
      }

      selectPath(previousPath, true);
    } else {
      selectAllChanges(false);
    }
  },
  applyPatch(path, patch) {
    if (selectedPath !== path) {
      return;
    }

    const nextDiffFiles = patchFiles(patch);
    focusedPatchCache.set(path, nextDiffFiles);

    if (diffFilesSignature(currentDiffFiles) === diffFilesSignature(nextDiffFiles)) {
      return;
    }

    selectedPath = path;
    currentDiffFiles = nextDiffFiles;
    renderDiff(currentDiffFiles);
  },
  applyPreferences(preferences) {
    refreshInterval.value = `${preferences.refreshIntervalMilliseconds}`;
    applyAutoRefreshPreference(preferences.autoRefreshEnabled);
    setUiZoomPercent(preferences.uiZoomPercent, false);
    setSidebarWidthPoints(preferences.sidebarWidthPoints, false);
  },
};

setAutoRefreshEnabled(true, false);
setUiZoomPercent(defaultZoomPercent, false);
setSidebarWidthPoints(defaultSidebarWidthPoints, false);
render();
postNative({ type: "web-ready" });
