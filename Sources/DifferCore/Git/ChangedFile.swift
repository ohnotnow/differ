import Foundation

public struct ChangedFile: Codable, Equatable, Identifiable, Sendable {
    public let path: String
    public let oldPath: String?
    public let status: GitFileStatus
    public let indexStatus: String
    public let workTreeStatus: String

    public var id: String {
        oldPath.map { "\($0)->\(path)" } ?? path
    }

    public init(
        path: String,
        oldPath: String? = nil,
        status: GitFileStatus,
        indexStatus: String,
        workTreeStatus: String
    ) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.indexStatus = indexStatus
        self.workTreeStatus = workTreeStatus
    }
}

public enum GitFileStatus: String, Codable, Equatable, Sendable {
    case added
    case modified
    case deleted
    case renamed
    case copied
    case untracked
    case ignored
    case conflicted
    case mixed
}
