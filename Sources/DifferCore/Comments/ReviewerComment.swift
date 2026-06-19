import Foundation

public struct ReviewerCommentsDocument: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public let schemaVersion: Int
    public let repositoryPath: String
    public let updatedAt: Date
    public let comments: [ReviewerComment]

    public init(
        schemaVersion: Int = Self.currentSchemaVersion,
        repositoryPath: String,
        updatedAt: Date,
        comments: [ReviewerComment]
    ) {
        self.schemaVersion = schemaVersion
        self.repositoryPath = repositoryPath
        self.updatedAt = updatedAt
        self.comments = comments
    }
}

public struct ReviewerComment: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let revision: Int
    public let state: ReviewerCommentState
    public let body: String
    public let createdAt: Date
    public let updatedAt: Date
    public let resolvedAt: Date?
    public let reference: String
    public let selection: ReviewerCommentSelection
    public let snippet: String?
    public let snapshotFingerprint: String?
    public let placement: ReviewerCommentPlacement?

    public init(
        id: String,
        revision: Int,
        state: ReviewerCommentState,
        body: String,
        createdAt: Date,
        updatedAt: Date,
        resolvedAt: Date? = nil,
        reference: String,
        selection: ReviewerCommentSelection,
        snippet: String? = nil,
        snapshotFingerprint: String? = nil,
        placement: ReviewerCommentPlacement? = nil
    ) {
        self.id = id
        self.revision = revision
        self.state = state
        self.body = body
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.resolvedAt = resolvedAt
        self.reference = reference
        self.selection = selection
        self.snippet = snippet
        self.snapshotFingerprint = snapshotFingerprint
        self.placement = placement
    }
}

public enum ReviewerCommentState: String, Codable, Equatable, Sendable {
    case open
    case resolved
}

public struct ReviewerCommentPlacement: Codable, Equatable, Sendable {
    public let status: ReviewerCommentPlacementStatus
    public let reason: String?
    public let checkedAt: Date

    public init(
        status: ReviewerCommentPlacementStatus,
        reason: String? = nil,
        checkedAt: Date
    ) {
        self.status = status
        self.reason = reason
        self.checkedAt = checkedAt
    }
}

public struct ReviewerCommentPlacementReport: Equatable, Sendable {
    public let id: String
    public let status: ReviewerCommentPlacementStatus
    public let reason: String?

    public init(
        id: String,
        status: ReviewerCommentPlacementStatus,
        reason: String? = nil
    ) {
        self.id = id
        self.status = status
        self.reason = reason
    }
}

public enum ReviewerCommentPlacementStatus: String, Codable, Equatable, Sendable {
    case mapped
    case unmapped
    case stale
}

public struct ReviewerCommentSelection: Codable, Equatable, Sendable {
    public let file: String
    public let oldFile: String?
    public let side: ReviewerCommentSide
    public let startLine: Int
    public let endLine: Int
    public let endSide: ReviewerCommentSide?

    public init(
        file: String,
        oldFile: String? = nil,
        side: ReviewerCommentSide,
        startLine: Int,
        endLine: Int,
        endSide: ReviewerCommentSide? = nil
    ) {
        self.file = file
        self.oldFile = oldFile
        self.side = side
        self.startLine = startLine
        self.endLine = endLine
        self.endSide = endSide
    }
}

public enum ReviewerCommentSide: String, Codable, Equatable, Sendable {
    case deletions
    case additions
}
