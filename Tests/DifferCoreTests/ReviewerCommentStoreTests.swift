import Foundation
import Testing
@testable import DifferCore

@Suite("Reviewer comment store")
struct ReviewerCommentStoreTests {
    @Test("loads a missing comments file as an empty document")
    func loadsMissingCommentsFileAsEmptyDocument() throws {
        let rootURL = try temporaryGitRepository()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let store = ReviewerCommentStore(now: { now })

        let document = try store.load(for: rootURL)

        #expect(document.schemaVersion == ReviewerCommentsDocument.currentSchemaVersion)
        #expect(document.repositoryPath.hasSuffix(rootURL.lastPathComponent))
        #expect(document.updatedAt == now)
        #expect(document.comments.isEmpty)
        #expect(FileManager.default.fileExists(atPath: try store.commentsFileURL(for: rootURL).path) == false)
    }

    @Test("saves reviewer comments under Git private storage")
    func savesReviewerCommentsUnderGitPrivateStorage() throws {
        let rootURL = try temporaryGitRepository()
        let now = Date(timeIntervalSince1970: 1_800_000_100)
        let store = ReviewerCommentStore(now: { now })
        let comment = reviewerComment(now: now)

        let savedDocument = try store.save(comments: [comment], for: rootURL)
        let commentsFileURL = try store.commentsFileURL(for: rootURL)
        let loadedDocument = try store.load(for: rootURL)

        #expect(commentsFileURL.path.hasSuffix("/.git/differ/comments.json"))
        #expect(commentsFileURL.path.hasPrefix("\(savedDocument.repositoryPath)/.git/"))
        #expect(savedDocument.repositoryPath.hasSuffix(rootURL.lastPathComponent))
        #expect(savedDocument.updatedAt == now)
        #expect(loadedDocument == savedDocument)
        #expect(loadedDocument.comments == [comment])
        #expect(loadedDocument.comments.first?.placement?.status == .mapped)
        #expect(loadedDocument.comments.first?.placement?.checkedAt == now)
        #expect(try gitStatus(in: rootURL).isEmpty)
    }

    @Test("rejects unsupported schema versions")
    func rejectsUnsupportedSchemaVersions() throws {
        let rootURL = try temporaryGitRepository()
        let store = ReviewerCommentStore()
        let commentsFileURL = try store.commentsFileURL(for: rootURL)
        try FileManager.default.createDirectory(
            at: commentsFileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try """
        {
          "schemaVersion": 999,
          "repositoryPath": "\(rootURL.path)",
          "updatedAt": "2027-01-15T08:00:00Z",
          "comments": []
        }
        """.write(to: commentsFileURL, atomically: true, encoding: .utf8)

        #expect(throws: ReviewerCommentStoreError.unsupportedSchemaVersion(999)) {
            _ = try store.load(for: rootURL)
        }
    }

    @Test("loads comments written before placement metadata")
    func loadsCommentsWrittenBeforePlacementMetadata() throws {
        let rootURL = try temporaryGitRepository()
        let store = ReviewerCommentStore()
        let commentsFileURL = try store.commentsFileURL(for: rootURL)
        try FileManager.default.createDirectory(
            at: commentsFileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try """
        {
          "schemaVersion": \(ReviewerCommentsDocument.currentSchemaVersion),
          "repositoryPath": "\(rootURL.path)",
          "updatedAt": "2027-01-15T08:00:00Z",
          "comments": [
            {
              "id": "comment-1",
              "revision": 1,
              "state": "open",
              "body": "Can we simplify this branch?",
              "createdAt": "2027-01-15T08:00:00Z",
              "updatedAt": "2027-01-15T08:00:00Z",
              "reference": "Web/src/main.ts:580-590",
              "selection": {
                "file": "Web/src/main.ts",
                "side": "additions",
                "startLine": 580,
                "endLine": 590
              }
            }
          ]
        }
        """.write(to: commentsFileURL, atomically: true, encoding: .utf8)

        let document = try store.load(for: rootURL)

        #expect(document.comments.count == 1)
        #expect(document.comments.first?.placement == nil)
        #expect(document.comments.first?.snapshotFingerprint == nil)
    }

    private func reviewerComment(now: Date) -> ReviewerComment {
        ReviewerComment(
            id: "comment-1",
            revision: 1,
            state: .open,
            body: "Can we simplify this branch?",
            createdAt: now,
            updatedAt: now,
            reference: "Web/src/main.ts:580-590",
            selection: ReviewerCommentSelection(
                file: "Web/src/main.ts",
                oldFile: "Web/src/old-main.ts",
                side: .additions,
                startLine: 580,
                endLine: 590
            ),
            snippet: """
            ```diff
            +const result = run();
            ```
            """,
            snapshotFingerprint: "fingerprint-1",
            placement: ReviewerCommentPlacement(
                status: .mapped,
                checkedAt: now
            )
        )
    }

    private func temporaryGitRepository() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "ReviewerCommentStoreTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let standardizedURL = url.standardizedFileURL
        try runGit(["init"], in: standardizedURL)
        return standardizedURL
    }

    private func gitStatus(in directoryURL: URL) throws -> String {
        let data = try runGit(["status", "--porcelain=v1"], in: directoryURL)
        return String(data: data, encoding: .utf8) ?? ""
    }

    @discardableResult
    private func runGit(_ arguments: [String], in directoryURL: URL) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git"] + arguments
        process.currentDirectoryURL = directoryURL

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        try process.run()
        process.waitUntilExit()

        let output = outputPipe.fileHandleForReading.readDataToEndOfFile()
        let error = errorPipe.fileHandleForReading.readDataToEndOfFile()

        guard process.terminationStatus == 0 else {
            let message = String(data: error, encoding: .utf8) ?? ""
            throw TestGitError.commandFailed(arguments, message)
        }

        return output
    }
}

private enum TestGitError: Error {
    case commandFailed([String], String)
}
