import Foundation

public struct GitSnapshot: Codable, Equatable, Sendable {
    public let repositoryPath: String
    public let files: [ChangedFile]
    public let allPatch: String
    public let generatedAt: Date

    public init(repositoryPath: String, files: [ChangedFile], allPatch: String, generatedAt: Date) {
        self.repositoryPath = repositoryPath
        self.files = files
        self.allPatch = allPatch
        self.generatedAt = generatedAt
    }
}

public enum GitDiffSelection: Equatable, Sendable {
    case all
    case file(ChangedFile)
}

public enum GitSnapshotError: Error, Equatable, LocalizedError, Sendable {
    case gitUnavailable(String)
    case gitCommandFailed(arguments: [String], exitCode: Int32, message: String)
    case invalidStatusOutput
    case unreadableUntrackedFile(String)
    case unsupportedDirectorySelection(String)

    public var errorDescription: String? {
        switch self {
        case .gitUnavailable(let message):
            "Git is not available: \(message)"
        case .gitCommandFailed(let arguments, let exitCode, let message):
            "git \(arguments.joined(separator: " ")) failed with status \(exitCode): \(message)"
        case .invalidStatusOutput:
            "Git returned status output Differ could not parse."
        case .unreadableUntrackedFile(let path):
            "Could not read untracked file: \(path)"
        case .unsupportedDirectorySelection(let path):
            "Cannot generate a single-file patch for directory: \(path)"
        }
    }
}
