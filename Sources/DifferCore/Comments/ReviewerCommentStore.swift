import Foundation

public struct ReviewerCommentStore: Sendable {
    private let runner: GitCommandRunner
    private let now: @Sendable () -> Date

    public init(now: @escaping @Sendable () -> Date = Date.init) {
        self.runner = GitCommandRunner()
        self.now = now
    }

    init(runner: GitCommandRunner, now: @escaping @Sendable () -> Date = Date.init) {
        self.runner = runner
        self.now = now
    }

    public func commentsFileURL(for repositoryURL: URL) throws -> URL {
        let data = try runner.run(
            ["rev-parse", "--path-format=absolute", "--git-path", "differ/comments.json"],
            in: repositoryURL
        )

        guard let path = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            path.isEmpty == false
        else {
            throw ReviewerCommentStoreError.invalidCommentsPath
        }

        return URL(fileURLWithPath: path, isDirectory: false)
    }

    public func load(for repositoryURL: URL) throws -> ReviewerCommentsDocument {
        let repositoryPath = try resolvedRepositoryRoot(for: repositoryURL).path
        let commentsFileURL = try commentsFileURL(for: repositoryURL)

        guard FileManager.default.fileExists(atPath: commentsFileURL.path) else {
            return ReviewerCommentsDocument(
                repositoryPath: repositoryPath,
                updatedAt: now(),
                comments: []
            )
        }

        let data = try Data(contentsOf: commentsFileURL)
        let document = try decoder.decode(ReviewerCommentsDocument.self, from: data)

        guard document.schemaVersion == ReviewerCommentsDocument.currentSchemaVersion else {
            throw ReviewerCommentStoreError.unsupportedSchemaVersion(document.schemaVersion)
        }

        return document
    }

    @discardableResult
    public func save(comments: [ReviewerComment], for repositoryURL: URL) throws -> ReviewerCommentsDocument {
        let document = ReviewerCommentsDocument(
            repositoryPath: try resolvedRepositoryRoot(for: repositoryURL).path,
            updatedAt: now(),
            comments: comments
        )

        try save(document, for: repositoryURL)
        return document
    }

    public func save(_ document: ReviewerCommentsDocument, for repositoryURL: URL) throws {
        guard document.schemaVersion == ReviewerCommentsDocument.currentSchemaVersion else {
            throw ReviewerCommentStoreError.unsupportedSchemaVersion(document.schemaVersion)
        }

        let commentsFileURL = try commentsFileURL(for: repositoryURL)
        let directoryURL = commentsFileURL.deletingLastPathComponent()

        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )

        let data = try encoder.encode(document)
        try data.write(to: commentsFileURL, options: [.atomic])
    }

    private func resolvedRepositoryRoot(for repositoryURL: URL) throws -> URL {
        let data = try runner.run(["rev-parse", "--show-toplevel"], in: repositoryURL)

        guard let path = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            path.isEmpty == false
        else {
            throw GitSnapshotError.gitCommandFailed(
                arguments: ["rev-parse", "--show-toplevel"],
                exitCode: 0,
                message: "git did not return a repository root"
            )
        }

        return URL(fileURLWithPath: path, isDirectory: true)
    }

    private var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    private var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

public enum ReviewerCommentStoreError: Error, Equatable, LocalizedError, Sendable {
    case invalidCommentsPath
    case unsupportedSchemaVersion(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidCommentsPath:
            "Git did not return a valid comments path."
        case .unsupportedSchemaVersion(let schemaVersion):
            "Reviewer comments schema version \(schemaVersion) is not supported."
        }
    }
}
