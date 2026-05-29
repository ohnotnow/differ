import Foundation

public struct GitSnapshotService: Sendable {
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

    public func snapshot(for repositoryURL: URL) throws -> GitSnapshot {
        let rootURL = try resolvedRepositoryRoot(for: repositoryURL)
        let statusData = try runner.run(
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            in: rootURL
        )
        let files = try statusParser.parse(statusData)
        let patch = try patch(for: .all, files: files, in: rootURL)

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
        let files = try statusParser.parse(statusData)

        return try patch(for: selection, files: files, in: rootURL)
    }

    private func patch(for selection: GitDiffSelection, files: [ChangedFile], in rootURL: URL) throws -> String {
        switch selection {
        case .all:
            let trackedPatch = try stringOutput(
                ["diff", "--no-ext-diff", "--binary", "HEAD", "--"],
                in: rootURL
            )
            let untrackedPatches = try files
                .filter { $0.status == .untracked }
                .map { try untrackedPatchBuilder.patch(for: $0.path, in: rootURL) }
                .joined(separator: "\n")

            if trackedPatch.isEmpty {
                return untrackedPatches
            }

            if untrackedPatches.isEmpty {
                return trackedPatch
            }

            return trackedPatch + "\n" + untrackedPatches

        case .file(let file) where file.status == .untracked:
            return try untrackedPatchBuilder.patch(for: file.path, in: rootURL)

        case .file(let file):
            return try stringOutput(
                ["diff", "--no-ext-diff", "--binary", "HEAD", "--", file.path],
                in: rootURL
            )
        }
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

    private func stringOutput(_ arguments: [String], in repositoryURL: URL) throws -> String {
        let data = try runner.run(arguments, in: repositoryURL)
        return String(data: data, encoding: .utf8) ?? ""
    }
}
