import {
  File as FileView,
  FileDiff,
  parsePatchFiles,
  resolveTheme,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  type SelectedLineRange,
  type SelectionSide,
} from "@pierre/diffs";
import { FileTree, themeToTreeStyles, type GitStatusEntry, type TreeThemeStyles } from "@pierre/trees";
import { applyDiffFontFamily, normalizedFontFamilies } from "./fontPreferences";
import { filesMostRecentlyModifiedFirst } from "./recentChanges";
import { formatDiffSelection, type DiffSelectionCopyMode } from "./selectionCopy";
import "./styles.css";

type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "ignored" | "conflicted" | "mixed";

type ChangedFile = {
  path: string;
  oldPath?: string;
  status: FileStatus;
  indexStatus?: string;
  workTreeStatus?: string;
  contents?: string;
  modificationDate?: string;
};

type AggregateView = "all" | "recent";

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
  theme: string;
  fontFamily?: string;
  availableFontFamilies?: string[];
  hiddenAllChangesPaths?: string[];
};

type ReviewerCommentState = "open" | "resolved";
type ReviewerCommentSide = "deletions" | "additions";
type ReviewerCommentPlacementStatus = "mapped" | "unmapped" | "stale";

type ReviewerCommentSelection = {
  file: string;
  oldFile?: string;
  side: ReviewerCommentSide;
  startLine: number;
  endLine: number;
  endSide?: ReviewerCommentSide;
};

type ReviewerComment = {
  id: string;
  revision: number;
  state: ReviewerCommentState;
  body: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  reference: string;
  selection: ReviewerCommentSelection;
  snippet?: string;
  snapshotFingerprint?: string;
  placement?: ReviewerCommentPlacement;
};

type ReviewerCommentPlacement = {
  status: ReviewerCommentPlacementStatus;
  reason?: string;
  checkedAt?: string;
};

type ReviewerCommentPlacementReport = {
  id: string;
  status: ReviewerCommentPlacementStatus;
  reason?: string;
};

type ReviewerCommentsDocument = {
  schemaVersion: number;
  repositoryPath: string;
  updatedAt: string;
  comments: ReviewerComment[];
};

type NativeMessage =
  | { type: "select-file"; path: string }
  | { type: "select-all" }
  | { type: "set-auto-refresh"; enabled: boolean }
  | { type: "set-refresh-interval"; milliseconds: number }
  | { type: "set-ui-zoom"; percent: number }
  | { type: "set-sidebar-width"; points: number }
  | { type: "set-theme"; theme: string }
  | { type: "set-font-family"; fontFamily: string }
  | { type: "set-all-changes-path-hidden"; path: string; hidden: boolean }
  | { type: "copy-to-clipboard"; text: string }
  | {
      type: "create-comment";
      body: string;
      reference: string;
      selection: ReviewerCommentSelection;
      snippet?: string;
      snapshotFingerprint?: string;
    }
  | { type: "update-comment"; id: string; body: string }
  | { type: "resolve-comment"; id: string }
  | { type: "reopen-comment"; id: string }
  | { type: "delete-comment"; id: string }
  | { type: "set-comment-placements"; placements: ReviewerCommentPlacementReport[] }
  | { type: "web-ready" };

type RenderedView = {
  cleanUp: () => void;
  setSelectedLines?: (range: SelectedLineRange | null, options?: { notify?: boolean }) => void;
};

type CommentDraftContext = {
  fileDiff: FileDiffMetadata;
  range: SelectedLineRange;
  reference: string;
  snippet?: string;
};

type DiffSelectionPoint = {
  lineNumber: number;
  side: SelectionSide;
};

type NativeSelectionLine = DiffSelectionPoint & {
  rowIndex: number;
};

type ActiveDiffSelection = {
  fileDiff: FileDiffMetadata;
  range: SelectedLineRange;
};

declare global {
  interface Window {
    Differ?: {
      applySnapshot: (snapshot: DifferSnapshot) => void;
      applyPatch: (path: string, patch: string) => void;
      applyPreferences: (preferences: DifferPreferences) => void;
      applyComments: (comments: ReviewerCommentsDocument) => void;
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
const zoomSelect = mustFind<HTMLSelectElement>("#zoom-select");
const fontSelect = mustFind<HTMLSelectElement>("#font-select");
const themeButton = mustFind<HTMLButtonElement>("#theme-button");
const themeMenu = mustFind<HTMLElement>("#theme-menu");
const themeMenuItems = Array.from(themeMenu.querySelectorAll<HTMLButtonElement>(".theme-menu-item"));
const sidebar = mustFind<HTMLElement>(".sidebar");
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

const defaultTheme = "pierre-dark";
const availableThemes = [
  "pierre-dark",
  "pierre-dark-soft",
  "nord",
  "github-dark",
  "tokyo-night",
  "gruvbox-dark-medium",
  "catppuccin-mocha",
];

const emptySnapshot: DifferSnapshot = {
  repositoryPath: "",
  generatedAt: new Date(0).toISOString(),
  files: [],
  allPatch: "",
};

let snapshot = emptySnapshot;
let hasNativeSnapshot = false;
let selectedPath: string | null = null;
let aggregateView: AggregateView = "all";
let allDiffFiles: FileDiffMetadata[] = [];
let currentDiffFiles = allDiffFiles;

let tree: FileTree | null = null;
let renderedFileListKey: string | null = null;
const fileRowCache = new Map<string, HTMLDivElement>();
const focusedPatchCache = new Map<string, FileDiffMetadata[]>();
let syncingTreeSelection = false;
let treeSyncGeneration = 0;
let renderedTreeDataKey: string | null = null;
let renderedViews: RenderedView[] = [];
let uiZoomPercent = defaultZoomPercent;
let sidebarWidthPoints = defaultSidebarWidthPoints;
let currentTheme = defaultTheme;
let availableFontFamilies: string[] = [];
let currentFontFamily = "";
const treeStylesCache = new Map<string, TreeThemeStyles>();
let autoRefreshEnabled = true;
let hiddenAllChangesPaths = new Set<string>();
let reviewerCommentsDocument: ReviewerCommentsDocument | null = null;
let reportedCommentPlacementSignature: string | null = null;
let pendingAutoRefreshEnabled: boolean | null = null;
let typographyReflowFrame: number | null = null;
let activeDiffSelection: ActiveDiffSelection | null = null;
let copyMenu: HTMLElement | null = null;
let commentComposer: HTMLElement | null = null;

function render() {
  const hiddenCount = hiddenChangedFiles().length;
  changeCount.textContent = hasNativeSnapshot
    ? `${snapshot.files.length} ${snapshot.files.length === 1 ? "change" : "changes"}${
        hiddenCount > 0 ? `, ${hiddenCount} hidden` : ""
      }`
    : "Waiting";
  selectionTitle.textContent = hasNativeSnapshot
    ? selectedPath ?? (aggregateView === "recent" ? "Recent changes" : "All changes")
    : "Waiting for repository snapshot";

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
    const retainedKeys = new Set(["__all__", "__recent__", ...snapshot.files.map((file) => file.path)]);

    for (const [key, button] of fileRowCache) {
      if (!retainedKeys.has(key)) {
        button.remove();
        fileRowCache.delete(key);
      }
    }
  }

  if (needsStructureSync) {
    const fragment = document.createDocumentFragment();
    fragment.append(
      buttonForFileRow("__all__", { path: "All changes", status: "mixed" }, selectedPath === null && aggregateView === "all"),
    );
    fragment.append(
      buttonForFileRow(
        "__recent__",
        { path: "Recent changes", status: "mixed" },
        selectedPath === null && aggregateView === "recent",
      ),
    );

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
    updateFileRow(
      allChangesRow,
      { path: "All changes", status: "mixed" },
      selectedPath === null && aggregateView === "all",
      false,
    );
  }

  const recentChangesRow = fileRowCache.get("__recent__");
  if (recentChangesRow) {
    updateFileRow(
      recentChangesRow,
      { path: "Recent changes", status: "mixed" },
      selectedPath === null && aggregateView === "recent",
      false,
    );
  }

  for (const file of snapshot.files) {
    const row = fileRowCache.get(file.path);
    if (row) {
      updateFileRow(row, file, selectedPath === file.path, isHiddenFromAllChanges(file.path));
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
  let row = fileRowCache.get(key);

  if (!row) {
    row = createFileRow(file, () => {
      if (key === "__all__") {
        selectAllChanges();
        return;
      }

      if (key === "__recent__") {
        selectRecentChanges();
        return;
      }

      selectPath(key);
    }, key === "__all__" || key === "__recent__" ? null : () => toggleAllChangesPathHidden(key));
    fileRowCache.set(key, row);
  }

  updateFileRow(row, file, selected, key !== "__all__" && key !== "__recent__" && isHiddenFromAllChanges(key));
  return row;
}

function createFileRow(
  file: Pick<ChangedFile, "path" | "status">,
  onSelect: () => void,
  onToggleHidden: (() => void) | null,
) {
  const row = document.createElement("div");
  row.className = "file-row";

  const selectButton = document.createElement("button");
  selectButton.className = "file-row-main";
  selectButton.type = "button";
  selectButton.addEventListener("click", onSelect);

  const badge = document.createElement("span");
  badge.className = "status-badge";

  const path = document.createElement("span");
  path.className = "file-path";

  selectButton.append(badge, path);
  row.append(selectButton);

  if (onToggleHidden) {
    const visibilityButton = document.createElement("button");
    visibilityButton.className = "file-row-visibility";
    visibilityButton.type = "button";
    visibilityButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onToggleHidden();
    });
    row.append(visibilityButton);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "file-row-visibility-spacer";
    spacer.setAttribute("aria-hidden", "true");
    row.append(spacer);
  }

  updateFileRow(row, file, false, false);
  return row;
}

function updateFileRow(row: HTMLDivElement, file: Pick<ChangedFile, "path" | "status">, selected: boolean, hidden: boolean) {
  const hiddenCount = hiddenChangedFiles().length;
  const title = fileRowTitle(file, hiddenCount);
  const selectButton = row.querySelector<HTMLButtonElement>(".file-row-main");
  const visibilityButton = row.querySelector<HTMLButtonElement>(".file-row-visibility");
  const badge = row.querySelector<HTMLElement>(".status-badge");
  const path = row.querySelector<HTMLElement>(".file-path");

  row.classList.toggle("selected", selected);
  row.classList.toggle("hidden-from-all", hidden);

  if (selectButton) {
    selectButton.title = title;
    selectButton.setAttribute("aria-label", title);
  }

  if (badge) {
    const isRecentChanges = file.path === "Recent changes";
    const badgeTitle = isRecentChanges ? "Most recently modified first" : statusTitle(file.status);
    badge.className = `status-badge ${isRecentChanges ? "recent" : file.status}`;
    badge.textContent = isRecentChanges ? "◷" : statusLabel(file.status);
    badge.title = badgeTitle;
    badge.setAttribute("aria-label", badgeTitle);
  }

  if (path) {
    path.textContent = file.path;
    path.title = file.path;
  }

  if (visibilityButton) {
    const label = hidden ? `Show ${file.path} in All changes` : `Hide ${file.path} from All changes`;
    visibilityButton.title = label;
    visibilityButton.setAttribute("aria-label", label);
    visibilityButton.setAttribute("aria-pressed", `${hidden}`);
    visibilityButton.innerHTML = visibilityIcon(hidden);
  }
}

function fileRowTitle(file: Pick<ChangedFile, "path" | "status">, hiddenCount: number) {
  if (file.path === "All changes") {
    return hiddenCount > 0 ? `All changed files, ${hiddenCount} hidden` : "All changed files";
  }

  if (file.path === "Recent changes") {
    return hiddenCount > 0
      ? `Changed files, most recently modified first, ${hiddenCount} hidden`
      : "Changed files, most recently modified first";
  }

  return `${statusTitle(file.status)}: ${file.path}`;
}

function syncFileRowSelection() {
  fileRowCache.get("__all__")?.classList.toggle("selected", selectedPath === null && aggregateView === "all");
  fileRowCache.get("__recent__")?.classList.toggle("selected", selectedPath === null && aggregateView === "recent");

  for (const file of snapshot.files) {
    const row = fileRowCache.get(file.path);
    row?.classList.toggle("selected", selectedPath === file.path);
    row?.classList.toggle("hidden-from-all", isHiddenFromAllChanges(file.path));
  }
}

function selectAllChanges(notifyNative = true) {
  selectedPath = null;
  aggregateView = "all";
  currentDiffFiles = diffFilesForAllChanges();

  if (notifyNative) {
    postNative({ type: "select-all" });
  }

  render();
}

function selectRecentChanges(notifyNative = true) {
  selectedPath = null;
  aggregateView = "recent";
  currentDiffFiles = diffFilesForRecentChanges();

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

function diffFilesForAllChanges() {
  const hiddenFiles = hiddenChangedFiles();

  if (hiddenFiles.length === 0) {
    return allDiffFiles;
  }

  return allDiffFiles.filter((fileDiff) => {
    return hiddenFiles.some((file) => diffMatchesChangedFile(fileDiff, file)) === false;
  });
}

function diffFilesForRecentChanges() {
  return recentlyChangedFiles().flatMap((file) => allDiffFiles.filter((fileDiff) => diffMatchesChangedFile(fileDiff, file)));
}

function diffFilesForCurrentAggregate() {
  return aggregateView === "recent" ? diffFilesForRecentChanges() : diffFilesForAllChanges();
}

function toggleAllChangesPathHidden(path: string) {
  const hidden = !isHiddenFromAllChanges(path);

  if (hidden) {
    hiddenAllChangesPaths.add(path);
  } else {
    hiddenAllChangesPaths.delete(path);
  }

  if (selectedPath === null) {
    currentDiffFiles = diffFilesForCurrentAggregate();
  }

  postNative({ type: "set-all-changes-path-hidden", path, hidden });
  render();
}

function applyHiddenAllChangesPaths(paths: string[], renderNow = true) {
  hiddenAllChangesPaths = normalizedPathSet(paths);

  if (selectedPath === null) {
    currentDiffFiles = diffFilesForCurrentAggregate();
  }

  if (renderNow) {
    render();
  }
}

function hiddenChangedFiles() {
  return snapshot.files.filter((file) => isHiddenFromAllChanges(file.path));
}

function includedChangedFilesForAllChanges() {
  return snapshot.files.filter((file) => isHiddenFromAllChanges(file.path) === false);
}

function recentlyChangedFiles() {
  return filesMostRecentlyModifiedFirst(includedChangedFilesForAllChanges());
}

function isHiddenFromAllChanges(path: string) {
  return hiddenAllChangesPaths.has(path);
}

function normalizedPathSet(paths: string[]) {
  return new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0));
}

function visibilityIcon(hidden: boolean) {
  if (hidden) {
    return `
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M10.58 10.58A2 2 0 0 0 13.42 13.4" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M9.88 5.1A9.76 9.76 0 0 1 12 4.88c4.65 0 8.2 3.2 9.5 7.12a10.1 10.1 0 0 1-2.12 3.48" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M6.34 6.34A10 10 0 0 0 2.5 12c1.3 3.92 4.85 7.12 9.5 7.12 1.4 0 2.7-.3 3.85-.85" />
      </svg>
    `;
  }

  return `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" d="M2.5 12c1.3-3.92 4.85-7.12 9.5-7.12s8.2 3.2 9.5 7.12c-1.3 3.92-4.85 7.12-9.5 7.12S3.8 15.92 2.5 12Z" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 12a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 0 0-4.5 0Z" />
    </svg>
  `;
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
    reportReviewerCommentPlacements();
    diffHost.append(emptyState("No changes"));
    renderUnmappedComments(fileDiffs);
    return;
  }

  const missingFiles = missingDiffFiles(fileDiffs);

  if (fileDiffs.length === 0 && missingFiles.length === 0) {
    const message = selectedPath === null && hiddenChangedFiles().length > 0 ? "No included changes to show" : "No diff to show";
    reportReviewerCommentPlacements();
    diffHost.append(emptyState(message));
    renderUnmappedComments(fileDiffs);
    return;
  }

  reportReviewerCommentPlacements();

  for (const fileDiff of fileDiffs) {
    const frame = document.createElement("section");
    frame.className = "file-diff-frame";
    diffHost.append(frame);

    let view: FileDiff<ReviewerComment>;
    view = new FileDiff<ReviewerComment>({
      theme: currentTheme,
      diffStyle: "unified",
      hunkSeparators: "line-info-basic",
      overflow: "scroll",
      enableLineSelection: true,
      enableGutterUtility: true,
      renderGutterUtility(getHoveredRow) {
        return copySelectionButton(fileDiff, () => rangeForCopyAction(fileDiff, frame, getHoveredRow));
      },
      renderAnnotation(annotation) {
        return reviewerCommentElement(annotation.metadata);
      },
      onLineSelectionStart(range) {
        clearOtherDiffSelections(view);
        setActiveDiffSelection(fileDiff, range);
      },
      onLineSelectionChange(range) {
        setActiveDiffSelection(fileDiff, range);
      },
      onLineSelected(range) {
        setActiveDiffSelection(fileDiff, range);
      },
    });

    renderedViews.push(view);
    view.render({
      fileDiff,
      containerWrapper: frame,
      lineAnnotations: commentAnnotationsForFileDiff(fileDiff),
    });
  }

  for (const file of missingFiles) {
    if (shouldRenderContentPreview(file)) {
      renderFilePreview(file);
    } else {
      diffHost.append(diffNotice(file));
    }
  }

  renderUnmappedComments(fileDiffs);
}

function copySelectionButton(fileDiff: FileDiffMetadata, range: () => SelectedLineRange | null) {
  const button = document.createElement("button");
  button.className = "copy-selection-button";
  button.type = "button";
  button.title = "Selection actions";
  button.setAttribute("aria-label", "Selection actions");
  button.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" d="M8 7.75A2.75 2.75 0 0 1 10.75 5h5.5A2.75 2.75 0 0 1 19 7.75v8.5A2.75 2.75 0 0 1 16.25 19h-5.5A2.75 2.75 0 0 1 8 16.25v-8.5Z" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M6.25 15.25H6A2.75 2.75 0 0 1 3.25 12.5v-7A2.75 2.75 0 0 1 6 2.75h4.5A2.75 2.75 0 0 1 13.25 5.5V6" />
    </svg>
  `;

  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const selectedRange = range();
    if (selectedRange) {
      openCopyMenu(button, fileDiff, selectedRange);
    }
  });

  return button;
}

function commentAnnotationsForFileDiff(fileDiff: FileDiffMetadata): DiffLineAnnotation<ReviewerComment>[] {
  return renderableCommentsForFileDiff(fileDiff)
    .map((comment) => ({
      side: comment.selection.side,
      lineNumber: comment.selection.startLine,
      metadata: comment,
    }));
}

function renderableCommentsForFileDiff(fileDiff: FileDiffMetadata) {
  return reviewerComments().filter((comment) => commentCanRenderInFileDiff(comment, fileDiff));
}

function commentCanRenderInFileDiff(comment: ReviewerComment, fileDiff: FileDiffMetadata) {
  return commentMatchesFileDiff(comment, fileDiff) && formatDiffSelection(fileDiff, selectedRangeForComment(comment), "reference") !== undefined;
}

function commentMatchesFileDiff(comment: ReviewerComment, fileDiff: FileDiffMetadata) {
  const diffPaths = [fileDiff.name, fileDiff.prevName].flatMap((path) => normalizedDiffPath(path));
  const commentPaths = [comment.selection.file, comment.selection.oldFile].flatMap((path) => normalizedDiffPath(path));

  return commentPaths.some((path) => diffPaths.includes(path));
}

function selectedRangeForComment(comment: ReviewerComment): SelectedLineRange {
  return {
    start: comment.selection.startLine,
    side: comment.selection.side,
    end: comment.selection.endLine,
    endSide: comment.selection.endSide ?? comment.selection.side,
  };
}

function reviewerComments() {
  return reviewerCommentsDocument?.comments ?? [];
}

function reportReviewerCommentPlacements() {
  const reports = reviewerCommentPlacementReports();
  const signature = reviewerCommentPlacementSignature(reports);

  if (signature === reportedCommentPlacementSignature) {
    return;
  }

  reportedCommentPlacementSignature = signature;

  if (reports.length === 0) {
    return;
  }

  postNative({ type: "set-comment-placements", placements: reports });
}

function reviewerCommentPlacementReports(): ReviewerCommentPlacementReport[] {
  const diffFiles = reviewerCommentPlacementDiffFiles();

  return reviewerComments().map((comment) => ({
    id: comment.id,
    ...reviewerCommentPlacement(comment, diffFiles),
  }));
}

function reviewerCommentPlacementSignature(reports: ReviewerCommentPlacementReport[]) {
  return reports.map((report) => `${report.id}\0${report.status}\0${report.reason ?? ""}`).join("\n");
}

function reviewerCommentPlacementDiffFiles() {
  return [...allDiffFiles, ...currentDiffFiles];
}

function reviewerCommentPlacement(
  comment: ReviewerComment,
  fileDiffs: FileDiffMetadata[],
): Pick<ReviewerCommentPlacementReport, "status" | "reason"> {
  if (!snapshot.files.some((file) => commentMatchesChangedFile(comment, file))) {
    return { status: "stale", reason: "file-not-in-current-changes" };
  }

  const matchingDiffFiles = fileDiffs.filter((fileDiff) => commentMatchesFileDiff(comment, fileDiff));

  if (matchingDiffFiles.some((fileDiff) => commentCanRenderInFileDiff(comment, fileDiff))) {
    return { status: "mapped" };
  }

  if (matchingDiffFiles.length === 0) {
    const reason = hiddenChangedFiles().some((file) => commentMatchesChangedFile(comment, file))
      ? "file-hidden-from-all-changes"
      : "diff-not-rendered";

    return { status: "unmapped", reason };
  }

  return { status: "unmapped", reason: "selected-lines-not-in-current-diff" };
}

function renderUnmappedComments(fileDiffs: FileDiffMetadata[]) {
  const comments = unmappedCommentsForCurrentView(fileDiffs);

  if (comments.length === 0) {
    return;
  }

  const panel = document.createElement("section");
  panel.className = "unmapped-comments-panel";

  const header = document.createElement("div");
  header.className = "unmapped-comments-header";

  const title = document.createElement("strong");
  title.className = "unmapped-comments-title";
  title.textContent = "Comments not shown in this diff";

  const detail = document.createElement("p");
  detail.className = "unmapped-comments-detail";
  detail.textContent =
    comments.length === 1
      ? "1 open comment is not anchored to a visible line."
      : `${comments.length} open comments are not anchored to visible lines.`;

  header.append(title, detail);

  const list = document.createElement("div");
  list.className = "unmapped-comments-list";

  for (const comment of comments) {
    list.append(reviewerCommentElement(comment));
  }

  panel.append(header, list);
  diffHost.append(panel);
}

function unmappedCommentsForCurrentView(fileDiffs: FileDiffMetadata[]) {
  const inlineCommentIDs = new Set(fileDiffs.flatMap((fileDiff) => renderableCommentsForFileDiff(fileDiff)).map((comment) => comment.id));
  const placementDiffFiles = reviewerCommentPlacementDiffFiles();

  return reviewerComments().filter((comment) => {
    if (comment.state !== "open" || inlineCommentIDs.has(comment.id) || !commentIsRelevantToCurrentView(comment)) {
      return false;
    }

    return reviewerCommentPlacement(comment, placementDiffFiles).status !== "mapped";
  });
}

function commentIsRelevantToCurrentView(comment: ReviewerComment) {
  return selectedPath === null || commentMatchesPath(comment, selectedPath);
}

function commentMatchesPath(comment: ReviewerComment, path: string) {
  const pathCandidates = normalizedDiffPath(path);
  const commentPaths = [comment.selection.file, comment.selection.oldFile].flatMap((commentPath) => normalizedDiffPath(commentPath));

  return commentPaths.some((commentPath) => pathCandidates.includes(commentPath));
}

function commentMatchesChangedFile(comment: ReviewerComment, file: ChangedFile) {
  const filePaths = [file.path, file.oldPath].flatMap((path) => normalizedDiffPath(path));
  const commentPaths = [comment.selection.file, comment.selection.oldFile].flatMap((path) => normalizedDiffPath(path));

  return commentPaths.some((path) => filePaths.includes(path));
}

function rangeForCopyAction(
  fileDiff: FileDiffMetadata,
  frame: HTMLElement,
  getHoveredRow: () => DiffSelectionPoint | undefined,
): SelectedLineRange | null {
  const nativeSelectionRange = rangeFromNativeSelection(frame);

  if (nativeSelectionRange) {
    return nativeSelectionRange;
  }

  if (activeDiffSelection?.fileDiff === fileDiff) {
    return activeDiffSelection.range;
  }

  const hoveredRow = getHoveredRow();

  if (!hoveredRow) {
    return null;
  }

  return {
    start: hoveredRow.lineNumber,
    side: hoveredRow.side,
    end: hoveredRow.lineNumber,
    endSide: hoveredRow.side,
  };
}

function rangeFromNativeSelection(frame: HTMLElement): SelectedLineRange | null {
  const selection = window.getSelection();

  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const selectedLines: NativeSelectionLine[] = [];

  for (const container of frame.querySelectorAll<HTMLElement>("diffs-container")) {
    const shadowRoot = container.shadowRoot;

    if (!shadowRoot) {
      continue;
    }

    for (const lineElement of shadowRoot.querySelectorAll<HTMLElement>("[data-line][data-line-index]")) {
      if (!selectionIntersectsElement(selection, lineElement)) {
        continue;
      }

      const line = nativeSelectionLine(lineElement);

      if (line) {
        selectedLines.push(line);
      }
    }
  }

  if (selectedLines.length === 0) {
    return null;
  }

  selectedLines.sort((left, right) => left.rowIndex - right.rowIndex);
  const start = selectedLines[0];
  const end = selectedLines.at(-1);

  if (!start || !end) {
    return null;
  }

  return {
    start: start.lineNumber,
    side: start.side,
    end: end.lineNumber,
    endSide: end.side,
  };
}

function selectionIntersectsElement(selection: Selection, element: HTMLElement) {
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);

    try {
      if (range.intersectsNode(element)) {
        return true;
      }
    } catch {
      // A selection can cross document/shadow boundaries. Ignore ranges that
      // cannot be compared with this rendered diff row.
    }
  }

  return false;
}

function nativeSelectionLine(lineElement: HTMLElement): NativeSelectionLine | null {
  const lineNumber = Number.parseInt(lineElement.dataset.line ?? "", 10);
  const lineIndex = firstLineIndex(lineElement.dataset.lineIndex);

  if (!Number.isFinite(lineNumber) || !Number.isFinite(lineIndex)) {
    return null;
  }

  return {
    lineNumber,
    rowIndex: lineIndex,
    side: sideForLineElement(lineElement),
  };
}

function firstLineIndex(value: string | undefined) {
  const [first] = value?.split(",") ?? [];
  return Number.parseInt(first ?? "", 10);
}

function sideForLineElement(lineElement: HTMLElement): SelectionSide {
  return lineElement.dataset.lineType === "change-deletion" ? "deletions" : "additions";
}

function openCopyMenu(anchor: HTMLElement, fileDiff: FileDiffMetadata, range: SelectedLineRange) {
  closeCopyMenu();
  closeCommentComposer();

  const menu = document.createElement("div");
  menu.className = "copy-selection-menu";
  menu.setAttribute("role", "menu");
  menu.append(
    copyMenuItem("Copy reference", "reference", fileDiff, range),
    copyMenuItem("Copy reference + contents", "reference-with-contents", fileDiff, range),
    commentMenuItem("Add comment", anchor, fileDiff, range),
  );
  document.body.append(menu);
  copyMenu = menu;
  positionCopyMenu(menu, anchor);
  document.addEventListener("pointerdown", onCopyMenuOutsidePointer, true);
  document.addEventListener("keydown", onCopyMenuKeydown, true);
}

function copyMenuItem(label: string, mode: DiffSelectionCopyMode, fileDiff: FileDiffMetadata, range: SelectedLineRange) {
  const button = document.createElement("button");
  button.className = "copy-selection-menu-item";
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.textContent = label;
  button.addEventListener("click", () => {
    copyDiffSelection(fileDiff, range, mode);
  });

  return button;
}

function commentMenuItem(label: string, anchor: HTMLElement, fileDiff: FileDiffMetadata, range: SelectedLineRange) {
  const button = document.createElement("button");
  button.className = "copy-selection-menu-item";
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.textContent = label;
  button.addEventListener("click", () => {
    const context = commentDraftContext(fileDiff, range);
    closeCopyMenu();

    if (context) {
      openCommentComposer(anchor, context);
    }
  });

  return button;
}

function commentDraftContext(fileDiff: FileDiffMetadata, range: SelectedLineRange): CommentDraftContext | null {
  const reference = formatDiffSelection(fileDiff, range, "reference");

  if (!reference) {
    return null;
  }

  return {
    fileDiff,
    range,
    reference,
    snippet: selectionSnippet(fileDiff, range, reference),
  };
}

function selectionSnippet(fileDiff: FileDiffMetadata, range: SelectedLineRange, reference: string) {
  const referenceWithContents = formatDiffSelection(fileDiff, range, "reference-with-contents");
  const prefix = `${reference}\n\n`;

  return referenceWithContents?.startsWith(prefix) ? referenceWithContents.slice(prefix.length) : undefined;
}

function reviewerCommentElement(comment: ReviewerComment) {
  const card = document.createElement("article");
  card.className = `review-comment ${comment.state}`;
  card.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  renderReviewerCommentDisplay(card, comment);
  return card;
}

function renderReviewerCommentDisplay(card: HTMLElement, comment: ReviewerComment) {
  card.replaceChildren();

  const header = document.createElement("div");
  header.className = "review-comment-header";

  const status = document.createElement("span");
  status.className = "review-comment-status";
  status.textContent = comment.state === "open" ? "Open" : "Resolved";

  const reference = document.createElement("span");
  reference.className = "comment-reference";
  reference.textContent = comment.reference;
  reference.title = comment.reference;

  header.append(status);

  if (comment.placement && comment.placement.status !== "mapped") {
    const placement = document.createElement("span");
    placement.className = `review-comment-status placement ${comment.placement.status}`;
    placement.textContent = reviewerCommentPlacementLabel(comment.placement.status);
    placement.title = comment.placement.reason ?? reviewerCommentPlacementLabel(comment.placement.status);
    header.append(placement);
  }

  header.append(reference);

  const body = document.createElement("p");
  body.className = "review-comment-body";
  body.textContent = comment.body;

  const actions = document.createElement("div");
  actions.className = "comment-actions";
  actions.append(
    commentActionButton("Edit", () => renderReviewerCommentEditor(card, comment)),
    comment.state === "open"
      ? commentActionButton("Resolve", () => postNative({ type: "resolve-comment", id: comment.id }))
      : commentActionButton("Reopen", () => postNative({ type: "reopen-comment", id: comment.id })),
    commentActionButton("Delete", () => renderReviewerCommentDeleteConfirm(card, comment), "danger"),
  );

  card.append(header, body, actions);
}

function renderReviewerCommentEditor(card: HTMLElement, comment: ReviewerComment) {
  card.replaceChildren();

  const form = document.createElement("form");
  form.className = "review-comment-editor";

  const textarea = document.createElement("textarea");
  textarea.className = "comment-textarea";
  textarea.rows = 4;
  textarea.value = comment.body;
  textarea.required = true;

  const actions = document.createElement("div");
  actions.className = "comment-actions";

  const cancel = document.createElement("button");
  cancel.className = "comment-button secondary";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    renderReviewerCommentDisplay(card, comment);
  });

  const save = document.createElement("button");
  save.className = "comment-button primary";
  save.type = "submit";
  save.textContent = "Save";

  actions.append(cancel, save);
  form.append(textarea, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const body = textarea.value.trim();
    if (body.length === 0) {
      textarea.focus();
      return;
    }

    postNative({ type: "update-comment", id: comment.id, body });
  });

  card.append(form);
  textarea.focus();
  textarea.select();
}

function renderReviewerCommentDeleteConfirm(card: HTMLElement, comment: ReviewerComment) {
  card.replaceChildren();

  const message = document.createElement("p");
  message.className = "review-comment-body";
  message.textContent = "Delete this comment?";

  const actions = document.createElement("div");
  actions.className = "comment-actions";
  actions.append(
    commentActionButton("Cancel", () => renderReviewerCommentDisplay(card, comment)),
    commentActionButton("Delete", () => postNative({ type: "delete-comment", id: comment.id }), "danger"),
  );

  card.append(message, actions);
}

function commentActionButton(label: string, action: () => void, tone: "default" | "danger" = "default") {
  const button = document.createElement("button");
  button.className = `comment-button secondary ${tone}`;
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);

  return button;
}

function reviewerCommentPlacementLabel(status: ReviewerCommentPlacementStatus) {
  switch (status) {
    case "mapped":
      return "Mapped";
    case "unmapped":
      return "Unmapped";
    case "stale":
      return "Stale";
  }
}

function positionCopyMenu(menu: HTMLElement, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(rect.right + 6, window.innerWidth - menu.offsetWidth - margin));
  const top = Math.max(margin, Math.min(rect.top, window.innerHeight - menu.offsetHeight - margin));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function closeCopyMenu() {
  if (!copyMenu) {
    return;
  }

  copyMenu.remove();
  copyMenu = null;
  document.removeEventListener("pointerdown", onCopyMenuOutsidePointer, true);
  document.removeEventListener("keydown", onCopyMenuKeydown, true);
}

function openCommentComposer(anchor: HTMLElement, context: CommentDraftContext) {
  closeCommentComposer();

  const form = document.createElement("form");
  form.className = "comment-composer";
  form.setAttribute("aria-label", "Add comment");

  const header = document.createElement("div");
  header.className = "comment-composer-header";

  const title = document.createElement("strong");
  title.className = "comment-composer-title";
  title.textContent = "Add comment";

  const reference = document.createElement("span");
  reference.className = "comment-reference";
  reference.textContent = context.reference;
  reference.title = context.reference;

  header.append(title, reference);

  const textarea = document.createElement("textarea");
  textarea.className = "comment-textarea";
  textarea.name = "body";
  textarea.rows = 4;
  textarea.placeholder = "Write a note for the agent";
  textarea.required = true;

  const actions = document.createElement("div");
  actions.className = "comment-actions";

  const cancel = document.createElement("button");
  cancel.className = "comment-button secondary";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    closeCommentComposer();
  });

  const submit = document.createElement("button");
  submit.className = "comment-button primary";
  submit.type = "submit";
  submit.textContent = "Add";

  actions.append(cancel, submit);
  form.append(header, textarea, actions);

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const body = textarea.value.trim();
    if (body.length === 0) {
      textarea.focus();
      return;
    }

    postNative({
      type: "create-comment",
      body,
      reference: context.reference,
      selection: reviewerCommentSelectionFromRange(context.fileDiff, context.range),
      snippet: context.snippet,
    });
    closeCommentComposer();
  });

  document.body.append(form);
  commentComposer = form;
  positionCopyMenu(form, anchor);
  window.setTimeout(() => textarea.focus(), 0);
  document.addEventListener("pointerdown", onCommentComposerOutsidePointer, true);
  document.addEventListener("keydown", onCommentComposerKeydown, true);
}

function reviewerCommentSelectionFromRange(fileDiff: FileDiffMetadata, range: SelectedLineRange): ReviewerCommentSelection {
  return {
    file: firstNormalizedDiffPath(fileDiff.name) ?? fileDiff.name,
    oldFile: firstNormalizedDiffPath(fileDiff.prevName),
    side: range.side ?? "additions",
    startLine: range.start,
    endLine: range.end,
    endSide: range.endSide,
  };
}

function closeCommentComposer() {
  if (!commentComposer) {
    return;
  }

  commentComposer.remove();
  commentComposer = null;
  document.removeEventListener("pointerdown", onCommentComposerOutsidePointer, true);
  document.removeEventListener("keydown", onCommentComposerKeydown, true);
}

function onCommentComposerOutsidePointer(event: PointerEvent) {
  const target = event.target as Node;

  if (commentComposer && !commentComposer.contains(target)) {
    closeCommentComposer();
  }
}

function onCommentComposerKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closeCommentComposer();
  }
}

function onCopyMenuOutsidePointer(event: PointerEvent) {
  const target = event.target as Node;

  if (copyMenu && !copyMenu.contains(target)) {
    closeCopyMenu();
  }
}

function onCopyMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closeCopyMenu();
  }
}

function copyDiffSelection(fileDiff: FileDiffMetadata, range: SelectedLineRange, mode: DiffSelectionCopyMode) {
  const text = formatDiffSelection(fileDiff, range, mode);

  if (!text) {
    closeCopyMenu();
    return;
  }

  copyTextToClipboard(text);
  closeCopyMenu();
}

function copyTextToClipboard(text: string) {
  if (window.webkit?.messageHandlers?.differ) {
    postNative({ type: "copy-to-clipboard", text });
    return;
  }

  void navigator.clipboard?.writeText(text).catch((error) => {
    console.error("Could not copy selected diff reference", error);
  });
}

function setActiveDiffSelection(fileDiff: FileDiffMetadata, range: SelectedLineRange | null) {
  if (range) {
    activeDiffSelection = { fileDiff, range };
    return;
  }

  if (activeDiffSelection?.fileDiff === fileDiff) {
    activeDiffSelection = null;
    closeCopyMenu();
  }
}

function clearOtherDiffSelections(activeView: RenderedView) {
  for (const view of renderedViews) {
    if (view !== activeView) {
      view.setSelectedLines?.(null, { notify: false });
    }
  }
}

function clearDiffSelectionState() {
  activeDiffSelection = null;
  closeCopyMenu();
  closeCommentComposer();
}

function emptyState(message: string) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function cleanRenderedViews() {
  clearDiffSelectionState();

  for (const view of renderedViews) {
    view.cleanUp();
  }

  renderedViews = [];
}

function missingDiffFiles(fileDiffs: FileDiffMetadata[]) {
  const candidates = selectedPath
    ? snapshot.files.filter((file) => file.path === selectedPath)
    : aggregateView === "recent"
      ? recentlyChangedFiles()
      : includedChangedFilesForAllChanges();

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
    theme: currentTheme,
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

function firstNormalizedDiffPath(path: string | undefined) {
  return normalizedDiffPath(path).at(-1);
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

  if (didChange) {
    scheduleTypographyReflow();
  }

  if (notifyNative) {
    postNative({ type: "set-ui-zoom", percent: nextZoomPercent });
  }
}

function scheduleTypographyReflow() {
  if (typographyReflowFrame !== null) {
    window.cancelAnimationFrame(typographyReflowFrame);
  }

  const scrollProgress = diffScrollProgress();
  typographyReflowFrame = window.requestAnimationFrame(() => {
    typographyReflowFrame = null;
    rebuildTreeForTypography();
    renderDiff(currentDiffFiles);

    window.requestAnimationFrame(() => {
      restoreDiffScrollProgress(scrollProgress);
    });
  });
}

function applyAvailableFontFamilies(fontFamilies: string[]) {
  availableFontFamilies = normalizedFontFamilies(fontFamilies);
  fontSelect.replaceChildren();

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "System Mono";
  fontSelect.append(defaultOption);

  for (const fontFamily of availableFontFamilies) {
    const option = document.createElement("option");
    option.value = fontFamily;
    option.textContent = fontFamily;
    option.style.fontFamily = fontFamily;
    fontSelect.append(option);
  }
}

function setFontFamily(fontFamily: string, notifyNative = true) {
  const nextFontFamily = availableFontFamilies.includes(fontFamily) ? fontFamily : "";
  const didChange = nextFontFamily !== currentFontFamily;

  currentFontFamily = nextFontFamily;
  fontSelect.value = nextFontFamily;

  applyDiffFontFamily(document.documentElement.style, nextFontFamily);

  if (didChange) {
    scheduleTypographyReflow();
  }

  if (notifyNative && didChange) {
    postNative({ type: "set-font-family", fontFamily: nextFontFamily });
  }
}

function rebuildTreeForTypography() {
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

  const container = appShell.clientWidth || window.innerWidth;
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 13;

  const minRendered = minimumSidebarWidthPoints;
  const maxRendered = Math.max(minRendered, container - reservedDiffRem * rootFontSize);
  const rendered = Math.min(maxRendered, Math.max(minRendered, points));

  return Math.min(maximumSidebarWidthPoints, Math.max(minimumSidebarWidthPoints, Math.round(rendered)));
}

function setTheme(name: string, notifyNative = true) {
  const nextTheme = availableThemes.includes(name) ? name : defaultTheme;
  const didChange = nextTheme !== currentTheme;

  currentTheme = nextTheme;
  syncThemeMenu();

  if (notifyNative && didChange) {
    postNative({ type: "set-theme", theme: nextTheme });
  }

  // Shiki loads themes lazily, so painting immediately would use the previously
  // resolved theme — the "one click behind" bug. Resolve first, then render.
  void applyTheme(nextTheme, didChange);
}

function syncThemeMenu() {
  for (const item of themeMenuItems) {
    const selected = item.dataset.theme === currentTheme;
    item.setAttribute("aria-checked", `${selected}`);

    const check = item.querySelector<HTMLElement>(".theme-menu-check");
    if (check) {
      check.textContent = selected ? "✓" : "";
    }

    if (selected) {
      themeButton.title = `Theme: ${item.textContent?.trim() ?? currentTheme}`;
    }
  }
}

function openThemeMenu() {
  themeMenu.hidden = false;
  themeButton.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", onThemeMenuOutsidePointer, true);
  document.addEventListener("keydown", onThemeMenuKeydown, true);
}

function closeThemeMenu() {
  themeMenu.hidden = true;
  themeButton.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onThemeMenuOutsidePointer, true);
  document.removeEventListener("keydown", onThemeMenuKeydown, true);
}

function onThemeMenuOutsidePointer(event: PointerEvent) {
  const target = event.target as Node;
  if (!themeMenu.contains(target) && !themeButton.contains(target)) {
    closeThemeMenu();
  }
}

function onThemeMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closeThemeMenu();
    themeButton.focus();
  }
}

async function applyTheme(name: string, renderDiffViews: boolean) {
  let styles = treeStylesCache.get(name);

  if (!styles) {
    try {
      const resolved = await resolveTheme(name);
      styles = themeToTreeStyles(resolved);
      treeStylesCache.set(name, styles);
    } catch (error) {
      console.error("Could not resolve theme", name, error);
      return;
    }
  }

  // A newer selection superseded this one while it was resolving.
  if (currentTheme !== name) {
    return;
  }

  for (const [property, value] of Object.entries(styles)) {
    sidebar.style.setProperty(property.startsWith("--") ? property : camelToKebab(property), value);
  }

  // themeToTreeStyles sets background-color; clear the decorative gradient so the
  // sidebar background is the theme's colour rather than a tinted blend.
  sidebar.style.setProperty("background-image", "none");

  if (renderDiffViews) {
    renderDiff(currentDiffFiles);
  }
}

function camelToKebab(property: string) {
  return property.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
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

themeButton.addEventListener("click", () => {
  if (themeMenu.hidden) {
    openThemeMenu();
  } else {
    closeThemeMenu();
  }
});

for (const item of themeMenuItems) {
  item.addEventListener("click", () => {
    const name = item.dataset.theme;
    if (name) {
      setTheme(name);
    }

    closeThemeMenu();
    themeButton.focus();
  });
}

zoomSelect.addEventListener("input", () => {
  setUiZoomPercent(Number.parseInt(zoomSelect.value, 10));
});

fontSelect.addEventListener("change", () => {
  setFontFamily(fontSelect.value);
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
    const shellLeft = appShell.getBoundingClientRect().left;
    setSidebarWidthPoints(moveEvent.clientX - shellLeft, false);
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
    const previousAggregateView = aggregateView;
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
      if (previousAggregateView === "recent") {
        selectRecentChanges(false);
      } else {
        selectAllChanges(false);
      }
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
    setTheme(preferences.theme, false);
    applyAvailableFontFamilies(preferences.availableFontFamilies ?? []);
    setFontFamily(preferences.fontFamily ?? "", false);
    applyHiddenAllChangesPaths(preferences.hiddenAllChangesPaths ?? []);
  },
  applyComments(comments) {
    reviewerCommentsDocument = comments;
    if (hasNativeSnapshot) {
      renderDiff(currentDiffFiles);
    }
  },
};

setAutoRefreshEnabled(true, false);
setUiZoomPercent(defaultZoomPercent, false);
setSidebarWidthPoints(defaultSidebarWidthPoints, false);
setTheme(defaultTheme, false);
applyAvailableFontFamilies([]);
setFontFamily("", false);
render();
postNative({ type: "web-ready" });
