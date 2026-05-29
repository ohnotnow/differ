import { FileDiff, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileTree, type GitStatusEntry } from "@pierre/trees";
import "./styles.css";

type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "ignored" | "conflicted" | "mixed";

type ChangedFile = {
  path: string;
  oldPath?: string;
  status: FileStatus;
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

const samplePatch = `diff --git a/Sources/Differ/App/AppState.swift b/Sources/Differ/App/AppState.swift
new file mode 100644
--- /dev/null
+++ b/Sources/Differ/App/AppState.swift
@@ -0,0 +1,10 @@
+import Foundation
+
+@MainActor
+final class AppState: ObservableObject {
+    @Published var selectedRepositoryURL: URL?
+}
diff --git a/Sources/DifferCore/Git/GitSnapshotService.swift b/Sources/DifferCore/Git/GitSnapshotService.swift
new file mode 100644
--- /dev/null
+++ b/Sources/DifferCore/Git/GitSnapshotService.swift
@@ -0,0 +1,8 @@
+import Foundation
+
+public struct GitSnapshotService: Sendable {
+    public init() {}
+}
`;

const sampleSnapshot: DifferSnapshot = {
  repositoryPath: "~/Documents/code/differ",
  generatedAt: new Date().toISOString(),
  files: [
    { path: "Sources/Differ/App/AppState.swift", status: "added" },
    { path: "Sources/Differ/WebView/DifferWebView.swift", status: "modified" },
    { path: "Sources/DifferCore/Git/GitSnapshotService.swift", status: "added" },
  ],
  allPatch: samplePatch,
};

const diffHost = mustFind<HTMLElement>("#diff-host");
const fallbackFiles = mustFind<HTMLElement>("#fallback-files");
const changeCount = mustFind<HTMLElement>("#change-count");
const selectionTitle = mustFind<HTMLElement>("#selection-title");
const manualRefresh = mustFind<HTMLButtonElement>("#manual-refresh");
const refreshInterval = mustFind<HTMLSelectElement>("#refresh-interval");
const treeHost = mustFind<HTMLElement>("#tree-host");

let snapshot = sampleSnapshot;
let selectedPath: string | null = null;
let currentPatch = sampleSnapshot.allPatch;

let tree: FileTree | null = null;

function render() {
  changeCount.textContent = `${snapshot.files.length} ${snapshot.files.length === 1 ? "change" : "changes"}`;
  selectionTitle.textContent = selectedPath ?? "All changes";

  renderFallbackFiles();
  renderTree();
  renderDiff(currentPatch);
}

function renderFallbackFiles() {
  fallbackFiles.replaceChildren();

  fallbackFiles.append(fileButton({ path: "All changes", status: "mixed" }, selectedPath === null, () => {
    selectedPath = null;
    currentPatch = snapshot.allPatch;
    postNative({ type: "select-all" });
    render();
  }));

  for (const file of snapshot.files) {
    fallbackFiles.append(fileButton(file, selectedPath === file.path, () => {
      selectedPath = file.path;
      postNative({ type: "select-file", path: file.path });
      render();
    }));
  }
}

function fileButton(file: Pick<ChangedFile, "path" | "status">, selected: boolean, onClick: () => void) {
  const button = document.createElement("button");
  button.className = selected ? "file-row selected" : "file-row";
  button.type = "button";
  button.addEventListener("click", onClick);

  const badge = document.createElement("span");
  badge.className = `status-badge ${file.status}`;
  badge.textContent = statusLabel(file.status);

  const path = document.createElement("span");
  path.className = "file-path";
  path.textContent = file.path;

  button.append(badge, path);
  return button;
}

function renderTree() {
  if (!tree) {
    tree = new FileTree({
      paths: snapshot.files.map((file) => file.path),
      initialExpansion: "open",
      initialSelectedPaths: selectedPath ? [selectedPath] : [],
      gitStatus: gitStatusEntries(),
      icons: { set: "minimal", colored: false },
      onSelectionChange(paths) {
        const [path] = paths;

        if (!path) {
          return;
        }

        selectedPath = path;
        postNative({ type: "select-file", path });
        renderFallbackFiles();
        selectionTitle.textContent = path;
      },
    });

    tree.render({ fileTreeContainer: treeHost });
    return;
  }

  tree.resetPaths(snapshot.files.map((file) => file.path));
  tree.setGitStatus(gitStatusEntries());

  if (selectedPath) {
    tree.getItem(selectedPath)?.select();
  }
}

function renderDiff(patch: string) {
  diffHost.replaceChildren();

  const files = patchFiles(patch);

  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No diff to show";
    diffHost.append(empty);
    return;
  }

  for (const fileDiff of files) {
    const frame = document.createElement("section");
    frame.className = "file-diff-frame";
    diffHost.append(frame);

    new FileDiff({
      theme: "pierre-dark",
      diffStyle: "unified",
      hunkSeparators: "line-info-basic",
      overflow: "scroll",
    }).render({
      fileDiff,
      containerWrapper: frame,
    });
  }
}

function patchFiles(patch: string): FileDiffMetadata[] {
  try {
    return parsePatchFiles(patch, "differ-preview", false).flatMap((parsed) => parsed.files);
  } catch (error) {
    console.error("Could not parse patch", error);
    return [];
  }
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
    snapshot = nextSnapshot;
    selectedPath = null;
    currentPatch = nextSnapshot.allPatch;
    render();
  },
  applyPatch(path, patch) {
    selectedPath = path;
    currentPatch = patch;
    render();
  },
  applyPreferences(preferences) {
    refreshInterval.value = `${preferences.refreshIntervalMilliseconds}`;
  },
};

render();
postNative({ type: "web-ready" });
