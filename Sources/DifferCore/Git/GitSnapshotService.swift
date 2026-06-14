import Foundation

public struct GitSnapshotService: Sendable {
    private static let maximumPreviewBytes = 512 * 1_024
    private static let maximumSnapshotPatchBytes = 2 * 1_024 * 1_024
    private static let maximumSelectedPatchBytes = 512 * 1_024

    private let runner: GitCommandRunner
    private let statusParser: PorcelainStatusParser
    private let untrackedPatchBuilder: UntrackedPatchBuilder

    public init() {
        self.runner = GitCommandRunner()
        self.statusParser = PorcelainStatusParser()
        self.untrackedPatchBuilder = UntrackedPatchBuilder()
    }

    init(
        runner: GitCommandRunner,
        statusParser: PorcelainStatusParser,
        untrackedPatchBuilder: UntrackedPatchBuilder
    ) {
        self.runner = runner
        self.statusParser = statusParser
        self.untrackedPatchBuilder = untrackedPatchBuilder
    }

    public func snapshot(for repositoryURL: URL, excludingPaths excludedPaths: Set<String> = []) throws -> GitSnapshot {
        let rootURL = try resolvedRepositoryRoot(for: repositoryURL)
        let statusData = try runner.run(
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            in: rootURL
        )
        let files = try filesWithContentPreviews(try statusParser.parse(statusData), in: rootURL)
        let patch = try patch(for: .all, files: files, excludingPaths: excludedPaths, in: rootURL)

        return GitSnapshot(
            repositoryPath: rootURL.path,
            files: files,
            allPatch: patch,
            generatedAt: Date()
        )
    }

    public func patch(for selection: GitDiffSelection, in repositoryURL: URL) throws -> String {
        let rootURL = try resolvedRepositoryRoot(for: repositoryURL)
        let statusData = try runner.run(
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            in: rootURL
        )
        let files = try filesWithContentPreviews(try statusParser.parse(statusData), in: rootURL)

        return try patch(for: selection, files: files, in: rootURL)
    }

    private func filesWithContentPreviews(_ files: [ChangedFile], in rootURL: URL) throws -> [ChangedFile] {
        try files.map { file in
            guard file.status == .untracked,
                  let contents = try previewContents(for: file.path, in: rootURL)
            else {
                return file
            }

            return ChangedFile(
                path: file.path,
                oldPath: file.oldPath,
                status: file.status,
                indexStatus: file.indexStatus,
                workTreeStatus: file.workTreeStatus,
                contents: contents
            )
        }
    }

    private func previewContents(for relativePath: String, in rootURL: URL) throws -> String? {
        let fileURL = rootURL.appending(path: relativePath)
        var isDirectory: ObjCBool = false

        guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue == false
        else {
            return nil
        }

        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        if let size = attributes[.size] as? NSNumber,
           size.intValue > Self.maximumPreviewBytes
        {
            return nil
        }

        let data = try Data(contentsOf: fileURL)

        guard data.contains(0) == false else {
            return nil
        }

        return String(data: data, encoding: .utf8)
    }

    private func patch(
        for selection: GitDiffSelection,
        files: [ChangedFile],
        excludingPaths excludedPaths: Set<String> = [],
        in rootURL: URL
    ) throws -> String {
        let repositoryHasHead = hasHead(in: rootURL)

        switch selection {
        case .all:
            return try aggregatedPatch(
                for: files,
                excludingPaths: excludedPaths,
                repositoryHasHead: repositoryHasHead,
                in: rootURL
            )

        case .file(let file) where file.status == .untracked:
            return try untrackedPatch(for: file, in: rootURL) ?? ""

        case .file(let file):
            return try trackedPatch(
                for: file.path,
                repositoryHasHead: repositoryHasHead,
                maximumBytes: Self.maximumSelectedPatchBytes,
                in: rootURL
            ) ?? ""
        }
    }

    private func aggregatedPatch(
        for files: [ChangedFile],
        excludingPaths excludedPaths: Set<String>,
        repositoryHasHead: Bool,
        in rootURL: URL
    ) throws -> String {
        var patches = [String]()
        var patchBytes = 0

        for file in files {
            guard excludedPaths.contains(file.path) == false else {
                continue
            }

            let patch: String?
            switch file.status {
            case .untracked:
                patch = try untrackedPatch(for: file, in: rootURL)
            case .ignored:
                patch = nil
            default:
                patch = try trackedPatch(
                    for: file.path,
                    repositoryHasHead: repositoryHasHead,
                    maximumBytes: Self.maximumSelectedPatchBytes,
                    in: rootURL
                )
            }

            guard let patch, patch.isEmpty == false else {
                continue
            }

            let separatorBytes = patches.isEmpty ? 0 : 1
            let nextBytes = patchBytes + separatorBytes + patch.utf8.count

            guard nextBytes <= Self.maximumSnapshotPatchBytes else {
                continue
            }

            patches.append(patch)
            patchBytes = nextBytes
        }

        return patches.joined(separator: "\n")
    }

    private func trackedPatch(
        for path: String?,
        repositoryHasHead: Bool,
        maximumBytes: Int,
        in rootURL: URL
    ) throws -> String? {
        if repositoryHasHead {
            return try limitedStringOutput(
                diffArguments(base: ["diff", "--no-ext-diff", "--binary", "HEAD"], path: path),
                maximumBytes: maximumBytes,
                in: rootURL
            )
        }

        guard let cachedPatch = try limitedStringOutput(
            diffArguments(base: ["diff", "--cached", "--no-ext-diff", "--binary"], path: path),
            maximumBytes: maximumBytes,
            in: rootURL
        ) else {
            return nil
        }

        let remainingBytes = maximumBytes - cachedPatch.utf8.count
        guard remainingBytes > 0 else {
            return cachedPatch
        }

        guard let workTreePatch = try limitedStringOutput(
            diffArguments(base: ["diff", "--no-ext-diff", "--binary"], path: path),
            maximumBytes: remainingBytes,
            in: rootURL
        ) else {
            return cachedPatch.isEmpty ? nil : cachedPatch
        }

        if cachedPatch.isEmpty {
            return workTreePatch
        }

        if workTreePatch.isEmpty {
            return cachedPatch
        }

        return cachedPatch + "\n" + workTreePatch
    }

    private func diffArguments(base: [String], path: String?) -> [String] {
        guard let path else {
            return base + ["--"]
        }

        return base + ["--", path]
    }

    private func untrackedPatch(for file: ChangedFile, in rootURL: URL) throws -> String? {
        guard try fileSize(for: file.path, in: rootURL) <= Self.maximumSelectedPatchBytes else {
            return nil
        }

        let patch = try untrackedPatchBuilder.patch(for: file.path, in: rootURL)

        guard patch.utf8.count <= Self.maximumSelectedPatchBytes else {
            return nil
        }

        return patch
    }

    private func resolvedRepositoryRoot(for repositoryURL: URL) throws -> URL {
        let data = try runner.run(["rev-parse", "--show-toplevel"], in: repositoryURL)
        guard let path = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !path.isEmpty
        else {
            throw GitSnapshotError.gitCommandFailed(
                arguments: ["rev-parse", "--show-toplevel"],
                exitCode: 0,
                message: "git did not return a repository root"
            )
        }

        return URL(fileURLWithPath: path, isDirectory: true)
    }

    private func hasHead(in rootURL: URL) -> Bool {
        (try? runner.run(["rev-parse", "--verify", "HEAD"], in: rootURL)) != nil
    }

    private func limitedStringOutput(_ arguments: [String], maximumBytes: Int, in repositoryURL: URL) throws -> String? {
        guard let data = try runner.run(arguments, maximumOutputBytes: maximumBytes, in: repositoryURL) else {
            return nil
        }

        return String(data: data, encoding: .utf8) ?? ""
    }

    private func fileSize(for relativePath: String, in rootURL: URL) throws -> Int {
        let fileURL = rootURL.appending(path: relativePath)
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = attributes[.size] as? NSNumber
        return size?.intValue ?? 0
    }
}
