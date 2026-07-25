import Foundation
import DifferCore

@MainActor
final class AppState: ObservableObject {
    private static let maximumStoredSnapshotFingerprintCharacters = 128

    @Published var selectedRepositoryURL: URL? = nil {
        didSet {
            defaults.set(selectedRepositoryURL?.path, forKey: DefaultsKey.selectedRepositoryPath)
            hiddenAllChangesPaths = storedHiddenAllChangesPaths(for: selectedRepositoryURL)
        }
    }

    @Published private(set) var snapshot: GitSnapshot?
    @Published private(set) var selectedPatch: SelectedPatch?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isLoading = false
    @Published private(set) var refreshIntervalMilliseconds: Int
    @Published private(set) var isAutoRefreshEnabled = true
    @Published private(set) var uiZoomPercent: Int
    @Published private(set) var sidebarWidthPoints: Int
    @Published private(set) var themeName: String
    @Published private(set) var fontFamilyName: String?
    @Published private(set) var hiddenAllChangesPaths = [String]()
    @Published private(set) var reviewerCommentsDocument: ReviewerCommentsDocument?

    let availableFontFamilies: [String]

    private let defaults: UserDefaults
    private let sharedDefaults: UserDefaults
    private let reviewerCommentStore: ReviewerCommentStore
    private var snapshotFingerprint: String?
    private var isRefreshing = false

    init(
        defaults: UserDefaults = .standard,
        sharedDefaults: UserDefaults = FontCatalog.sharedDefaults,
        reviewerCommentStore: ReviewerCommentStore = ReviewerCommentStore()
    ) {
        self.defaults = defaults
        self.sharedDefaults = sharedDefaults
        self.reviewerCommentStore = reviewerCommentStore
        self.availableFontFamilies = FontCatalog.availableMonospacedFamilies()

        if let path = defaults.string(forKey: DefaultsKey.selectedRepositoryPath), path.isEmpty == false {
            self.selectedRepositoryURL = URL(fileURLWithPath: path, isDirectory: true)
        }

        let storedRefreshInterval = defaults.integer(forKey: DefaultsKey.refreshIntervalMilliseconds)
        self.refreshIntervalMilliseconds = max(1_000, storedRefreshInterval > 0 ? storedRefreshInterval : 5_000)

        let storedZoomPercent = defaults.integer(forKey: DefaultsKey.uiZoomPercent)
        self.uiZoomPercent = Self.clampedZoomPercent(storedZoomPercent > 0 ? storedZoomPercent : 100)

        let storedSidebarWidth = defaults.integer(forKey: DefaultsKey.sidebarWidthPoints)
        self.sidebarWidthPoints = Self.clampedSidebarWidthPoints(storedSidebarWidth > 0 ? storedSidebarWidth : 300)

        let storedTheme = defaults.string(forKey: DefaultsKey.themeName)
        self.themeName = (storedTheme?.isEmpty == false) ? storedTheme! : Self.defaultThemeName

        let storedFontFamily = sharedDefaults.string(forKey: SharedDefaultsKey.fontFamilyName)
        self.fontFamilyName = availableFontFamilies.contains(storedFontFamily ?? "") ? storedFontFamily : nil

        self.hiddenAllChangesPaths = storedHiddenAllChangesPaths(for: selectedRepositoryURL)
        loadReviewerCommentsForSelectedRepository()
    }

    var selectedRepositoryDisplayName: String {
        selectedRepositoryURL?.lastPathComponent ?? "No repository selected"
    }

    func openRepository(_ url: URL) async {
        selectedRepositoryURL = url
        selectedPatch = nil
        loadReviewerCommentsForSelectedRepository()
        await refreshSnapshot()
    }

    func refreshSnapshot(showLoading: Bool = true) async {
        await refreshSnapshot(showLoading: showLoading, requiresAutoRefresh: false)
    }

    private func refreshSnapshot(showLoading: Bool, requiresAutoRefresh: Bool) async {
        guard let selectedRepositoryURL else {
            return
        }

        guard requiresAutoRefresh == false || isAutoRefreshEnabled else {
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
        defer {
            isRefreshing = false
            if showLoading {
                isLoading = false
            }
        }

        do {
            let hiddenPaths = Set(hiddenAllChangesPaths)
            let nextSnapshot = try await Task.detached(priority: .userInitiated) {
                try GitSnapshotService().snapshot(for: selectedRepositoryURL, excludingPaths: hiddenPaths)
            }.value

            guard requiresAutoRefresh == false || isAutoRefreshEnabled else {
                return
            }

            pruneHiddenAllChangesPaths(to: Set(nextSnapshot.files.map(\.path)))

            let nextFingerprint = fingerprint(for: nextSnapshot)
            if nextFingerprint != snapshotFingerprint {
                snapshot = nextSnapshot
                snapshotFingerprint = nextFingerprint
                selectedPatch = nil
            }
        } catch {
            guard requiresAutoRefresh == false || isAutoRefreshEnabled else {
                return
            }

            errorMessage = error.localizedDescription
        }
    }

    func runPollingLoop() async {
        while Task.isCancelled == false {
            await refreshSnapshot(showLoading: false, requiresAutoRefresh: true)

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

    func setAutoRefreshEnabled(_ enabled: Bool) async {
        guard isAutoRefreshEnabled != enabled else {
            return
        }

        isAutoRefreshEnabled = enabled

        if enabled {
            await refreshSnapshot()
        }
    }

    func setUiZoomPercent(_ percent: Int) {
        let clampedPercent = Self.clampedZoomPercent(percent)
        uiZoomPercent = clampedPercent
        defaults.set(clampedPercent, forKey: DefaultsKey.uiZoomPercent)
    }

    func setSidebarWidth(points: Int) {
        let clampedPoints = Self.clampedSidebarWidthPoints(points)
        sidebarWidthPoints = clampedPoints
        defaults.set(clampedPoints, forKey: DefaultsKey.sidebarWidthPoints)
    }

    func setTheme(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else {
            return
        }

        themeName = trimmed
        defaults.set(trimmed, forKey: DefaultsKey.themeName)
    }

    func setFontFamily(_ name: String?) {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextName = (trimmed?.isEmpty == false) ? trimmed : nil

        if let nextName, availableFontFamilies.contains(nextName) == false {
            return
        }

        fontFamilyName = nextName

        if let nextName {
            sharedDefaults.set(nextName, forKey: SharedDefaultsKey.fontFamilyName)
        } else {
            sharedDefaults.removeObject(forKey: SharedDefaultsKey.fontFamilyName)
        }
    }

    func setAllChangesPathHidden(path: String, hidden: Bool) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard selectedRepositoryURL != nil, trimmed.isEmpty == false else {
            return
        }

        var nextPaths = Set(hiddenAllChangesPaths)
        if hidden {
            nextPaths.insert(trimmed)
        } else {
            nextPaths.remove(trimmed)
        }

        let sortedPaths = nextPaths.sorted()
        guard sortedPaths != hiddenAllChangesPaths else {
            return
        }

        hiddenAllChangesPaths = sortedPaths
        storeHiddenAllChangesPaths(sortedPaths, for: selectedRepositoryURL)
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

    func createReviewerComment(
        body: String,
        reference: String,
        selection: ReviewerCommentSelection,
        snippet: String?,
        snapshotFingerprint: String?
    ) {
        guard let body = nonEmptyTrimmed(body),
              let reference = nonEmptyTrimmed(reference)
        else {
            return
        }

        let now = Date()
        let comment = ReviewerComment(
            id: UUID().uuidString,
            revision: 1,
            state: .open,
            body: body,
            createdAt: now,
            updatedAt: now,
            reference: reference,
            selection: selection,
            snippet: nonEmptyTrimmed(snippet),
            snapshotFingerprint: storedSnapshotFingerprint(snapshotFingerprint),
            placement: nil
        )

        saveReviewerComments(currentReviewerComments() + [comment])
    }

    func updateReviewerComment(id: String, body: String) {
        guard let id = nonEmptyTrimmed(id),
              let body = nonEmptyTrimmed(body)
        else {
            return
        }

        replaceReviewerComment(id: id) { comment, now in
            ReviewerComment(
                id: comment.id,
                revision: comment.revision + 1,
                state: comment.state,
                body: body,
                createdAt: comment.createdAt,
                updatedAt: now,
                resolvedAt: comment.resolvedAt,
                reference: comment.reference,
                selection: comment.selection,
                snippet: comment.snippet,
                snapshotFingerprint: storedSnapshotFingerprint(comment.snapshotFingerprint),
                placement: comment.placement
            )
        }
    }

    func resolveReviewerComment(id: String) {
        guard let id = nonEmptyTrimmed(id) else {
            return
        }

        replaceReviewerComment(id: id) { comment, now in
            guard comment.state != .resolved else {
                return nil
            }

            return ReviewerComment(
                id: comment.id,
                revision: comment.revision + 1,
                state: .resolved,
                body: comment.body,
                createdAt: comment.createdAt,
                updatedAt: now,
                resolvedAt: now,
                reference: comment.reference,
                selection: comment.selection,
                snippet: comment.snippet,
                snapshotFingerprint: storedSnapshotFingerprint(comment.snapshotFingerprint),
                placement: comment.placement
            )
        }
    }

    func reopenReviewerComment(id: String) {
        guard let id = nonEmptyTrimmed(id) else {
            return
        }

        replaceReviewerComment(id: id) { comment, now in
            guard comment.state != .open else {
                return nil
            }

            return ReviewerComment(
                id: comment.id,
                revision: comment.revision + 1,
                state: .open,
                body: comment.body,
                createdAt: comment.createdAt,
                updatedAt: now,
                resolvedAt: nil,
                reference: comment.reference,
                selection: comment.selection,
                snippet: comment.snippet,
                snapshotFingerprint: storedSnapshotFingerprint(comment.snapshotFingerprint),
                placement: comment.placement
            )
        }
    }

    func setReviewerCommentPlacements(_ reports: [ReviewerCommentPlacementReport]) {
        let placementsByID = reports.reduce(into: [String: ReviewerCommentPlacementReport]()) { result, report in
            guard let id = nonEmptyTrimmed(report.id) else {
                return
            }

            result[id] = report
        }

        guard placementsByID.isEmpty == false else {
            return
        }

        let now = Date()
        var didChange = false
        let nextComments = currentReviewerComments().map { comment in
            guard let report = placementsByID[comment.id] else {
                let sanitized = sanitizedReviewerComment(comment)
                didChange = didChange || sanitized != comment
                return sanitized
            }

            let nextPlacement = ReviewerCommentPlacement(
                status: report.status,
                reason: nonEmptyTrimmed(report.reason),
                checkedAt: now
            )

            let sanitized = sanitizedReviewerComment(comment)
            guard sanitized.placement?.status != nextPlacement.status ||
                sanitized.placement?.reason != nextPlacement.reason
            else {
                didChange = didChange || sanitized != comment
                return sanitized
            }

            didChange = true
            return ReviewerComment(
                id: sanitized.id,
                revision: sanitized.revision,
                state: sanitized.state,
                body: sanitized.body,
                createdAt: sanitized.createdAt,
                updatedAt: sanitized.updatedAt,
                resolvedAt: sanitized.resolvedAt,
                reference: sanitized.reference,
                selection: sanitized.selection,
                snippet: sanitized.snippet,
                snapshotFingerprint: sanitized.snapshotFingerprint,
                placement: nextPlacement
            )
        }

        guard didChange else {
            return
        }

        saveReviewerComments(nextComments)
    }

    func deleteReviewerComment(id: String) {
        guard let id = nonEmptyTrimmed(id) else {
            return
        }

        let comments = currentReviewerComments()
        let nextComments = comments.filter { $0.id != id }

        guard nextComments.count != comments.count else {
            return
        }

        saveReviewerComments(nextComments)
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

    private func pruneHiddenAllChangesPaths(to changedPaths: Set<String>) {
        let nextPaths = hiddenAllChangesPaths
            .filter { changedPaths.contains($0) }
            .sorted()

        guard nextPaths != hiddenAllChangesPaths else {
            return
        }

        hiddenAllChangesPaths = nextPaths
        storeHiddenAllChangesPaths(nextPaths, for: selectedRepositoryURL)
    }

    private func loadReviewerCommentsForSelectedRepository() {
        guard let selectedRepositoryURL else {
            reviewerCommentsDocument = nil
            return
        }

        do {
            reviewerCommentsDocument = try reviewerCommentStore.load(for: selectedRepositoryURL)
        } catch {
            reviewerCommentsDocument = nil
            errorMessage = error.localizedDescription
        }
    }

    private func currentReviewerComments() -> [ReviewerComment] {
        reviewerCommentsDocument?.comments ?? []
    }

    private func replaceReviewerComment(
        id: String,
        transform: (ReviewerComment, Date) -> ReviewerComment?
    ) {
        var comments = currentReviewerComments()
        guard let index = comments.firstIndex(where: { $0.id == id }) else {
            return
        }

        guard let nextComment = transform(comments[index], Date()) else {
            return
        }

        comments[index] = nextComment
        saveReviewerComments(comments)
    }

    private func saveReviewerComments(_ comments: [ReviewerComment]) {
        guard let selectedRepositoryURL else {
            return
        }

        do {
            reviewerCommentsDocument = try reviewerCommentStore.save(
                comments: comments.map(sanitizedReviewerComment),
                for: selectedRepositoryURL
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func sanitizedReviewerComment(_ comment: ReviewerComment) -> ReviewerComment {
        ReviewerComment(
            id: comment.id,
            revision: comment.revision,
            state: comment.state,
            body: comment.body,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
            resolvedAt: comment.resolvedAt,
            reference: comment.reference,
            selection: comment.selection,
            snippet: comment.snippet,
            snapshotFingerprint: storedSnapshotFingerprint(comment.snapshotFingerprint),
            placement: comment.placement
        )
    }

    private func storedSnapshotFingerprint(_ value: String?) -> String? {
        guard let trimmed = nonEmptyTrimmed(value),
              trimmed.count <= Self.maximumStoredSnapshotFingerprintCharacters
        else {
            return nil
        }

        return trimmed
    }

    private func storedHiddenAllChangesPaths(for repositoryURL: URL?) -> [String] {
        guard let repositoryPath = repositoryURL?.path else {
            return []
        }

        return hiddenAllChangesPathsByRepository()[repositoryPath]?.sorted() ?? []
    }

    private func storeHiddenAllChangesPaths(_ paths: [String], for repositoryURL: URL?) {
        guard let repositoryPath = repositoryURL?.path else {
            return
        }

        var pathsByRepository = hiddenAllChangesPathsByRepository()
        if paths.isEmpty {
            pathsByRepository.removeValue(forKey: repositoryPath)
        } else {
            pathsByRepository[repositoryPath] = paths
        }

        defaults.set(pathsByRepository, forKey: DefaultsKey.hiddenAllChangesPathsByRepository)
    }

    private func hiddenAllChangesPathsByRepository() -> [String: [String]] {
        guard let stored = defaults.dictionary(forKey: DefaultsKey.hiddenAllChangesPathsByRepository) else {
            return [:]
        }

        return stored.reduce(into: [String: [String]]()) { result, entry in
            guard let paths = entry.value as? [String] else {
                return
            }

            result[entry.key] = paths
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { $0.isEmpty == false }
                .sorted()
        }
    }

    private func nonEmptyTrimmed(_ value: String?) -> String? {
        guard let value else {
            return nil
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func clampedZoomPercent(_ percent: Int) -> Int {
        min(200, max(80, percent))
    }

    private static func clampedSidebarWidthPoints(_ points: Int) -> Int {
        min(2_000, max(140, points))
    }

    private static let defaultThemeName = "pierre-dark"
}

private enum DefaultsKey {
    static let selectedRepositoryPath = "selectedRepositoryPath"
    static let refreshIntervalMilliseconds = "refreshIntervalMilliseconds"
    static let uiZoomPercent = "uiZoomPercent"
    static let sidebarWidthPoints = "sidebarWidthPoints"
    static let themeName = "themeName"
    static let hiddenAllChangesPathsByRepository = "hiddenAllChangesPathsByRepository"
}

private enum SharedDefaultsKey {
    static let fontFamilyName = "fontFamilyName"
}

struct SelectedPatch: Equatable, Identifiable {
    let id = UUID()
    let path: String
    let patch: String
}
