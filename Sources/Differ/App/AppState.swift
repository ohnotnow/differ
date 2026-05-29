import Foundation
import DifferCore

@MainActor
final class AppState: ObservableObject {
    @Published var selectedRepositoryURL: URL? = nil {
        didSet {
            defaults.set(selectedRepositoryURL?.path, forKey: DefaultsKey.selectedRepositoryPath)
        }
    }

    @Published private(set) var snapshot: GitSnapshot?
    @Published private(set) var selectedPatch: SelectedPatch?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isLoading = false
    @Published private(set) var refreshIntervalMilliseconds: Int
    @Published private(set) var uiZoomPercent: Int

    private let defaults: UserDefaults
    private var snapshotFingerprint: String?
    private var isRefreshing = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults

        if let path = defaults.string(forKey: DefaultsKey.selectedRepositoryPath), path.isEmpty == false {
            self.selectedRepositoryURL = URL(fileURLWithPath: path, isDirectory: true)
        }

        let storedRefreshInterval = defaults.integer(forKey: DefaultsKey.refreshIntervalMilliseconds)
        self.refreshIntervalMilliseconds = max(1_000, storedRefreshInterval > 0 ? storedRefreshInterval : 5_000)

        let storedZoomPercent = defaults.integer(forKey: DefaultsKey.uiZoomPercent)
        self.uiZoomPercent = Self.clampedZoomPercent(storedZoomPercent > 0 ? storedZoomPercent : 100)
    }

    var selectedRepositoryDisplayName: String {
        selectedRepositoryURL?.lastPathComponent ?? "No repository selected"
    }

    func openRepository(_ url: URL) async {
        selectedRepositoryURL = url
        selectedPatch = nil
        await refreshSnapshot()
    }

    func refreshSnapshot(showLoading: Bool = true) async {
        guard let selectedRepositoryURL else {
            return
        }

        guard isRefreshing == false else {
            return
        }

        isRefreshing = true
        if showLoading {
            isLoading = true
        }
        errorMessage = nil

        do {
            let nextSnapshot = try await Task.detached(priority: .userInitiated) {
                try GitSnapshotService().snapshot(for: selectedRepositoryURL)
            }.value

            let nextFingerprint = fingerprint(for: nextSnapshot)
            if nextFingerprint != snapshotFingerprint {
                snapshot = nextSnapshot
                snapshotFingerprint = nextFingerprint
                selectedPatch = nil
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isRefreshing = false
        if showLoading {
            isLoading = false
        }
    }

    func runPollingLoop() async {
        while Task.isCancelled == false {
            await refreshSnapshot(showLoading: false)

            let interval = UInt64(max(1_000, refreshIntervalMilliseconds))
            try? await Task.sleep(nanoseconds: interval * 1_000_000)
        }
    }

    func selectAllChanges() {
        selectedPatch = nil
    }

    func setRefreshInterval(milliseconds: Int) {
        let clampedMilliseconds = max(1_000, milliseconds)
        refreshIntervalMilliseconds = clampedMilliseconds
        defaults.set(clampedMilliseconds, forKey: DefaultsKey.refreshIntervalMilliseconds)
    }

    func setUiZoomPercent(_ percent: Int) {
        let clampedPercent = Self.clampedZoomPercent(percent)
        uiZoomPercent = clampedPercent
        defaults.set(clampedPercent, forKey: DefaultsKey.uiZoomPercent)
    }

    func selectFile(path: String) async {
        guard let selectedRepositoryURL,
              let file = snapshot?.files.first(where: { $0.path == path })
        else {
            return
        }

        do {
            let patch = try await Task.detached(priority: .userInitiated) {
                try GitSnapshotService().patch(for: .file(file), in: selectedRepositoryURL)
            }.value

            selectedPatch = SelectedPatch(path: path, patch: patch)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func reportBridgeError(_ message: String) {
        errorMessage = message
    }

    private func fingerprint(for snapshot: GitSnapshot) -> String {
        let files = snapshot.files
            .map { "\($0.path)|\($0.oldPath ?? "")|\($0.status.rawValue)|\($0.indexStatus)|\($0.workTreeStatus)" }
            .joined(separator: "\n")

        return files + "\n---patch---\n" + snapshot.allPatch
    }

    private static func clampedZoomPercent(_ percent: Int) -> Int {
        min(180, max(80, percent))
    }
}

private enum DefaultsKey {
    static let selectedRepositoryPath = "selectedRepositoryPath"
    static let refreshIntervalMilliseconds = "refreshIntervalMilliseconds"
    static let uiZoomPercent = "uiZoomPercent"
}

struct SelectedPatch: Equatable, Identifiable {
    let id = UUID()
    let path: String
    let patch: String
}
