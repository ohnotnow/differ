import Foundation
import Testing
@testable import DifferCore

@Suite("Git snapshot service")
struct GitSnapshotServiceTests {
    @Test("captures tracked and untracked working tree changes")
    func capturesWorkingTreeChanges() throws {
        let rootURL = try temporaryDirectory()
        try runGit(["init"], in: rootURL)
        try runGit(["config", "user.name", "Differ Tests"], in: rootURL)
        try runGit(["config", "user.email", "differ@example.test"], in: rootURL)

        try "one\n".write(to: rootURL.appending(path: "Tracked.txt"), atomically: true, encoding: .utf8)
        try runGit(["add", "Tracked.txt"], in: rootURL)
        try runGit(["commit", "-m", "Initial commit"], in: rootURL)

        try "one\ntwo\n".write(to: rootURL.appending(path: "Tracked.txt"), atomically: true, encoding: .utf8)
        try "new\n".write(to: rootURL.appending(path: "Untracked.txt"), atomically: true, encoding: .utf8)

        let snapshot = try GitSnapshotService().snapshot(for: rootURL)

        #expect(snapshot.repositoryPath.hasSuffix(rootURL.lastPathComponent))
        #expect(snapshot.files.contains(
            ChangedFile(
                path: "Tracked.txt",
                status: .modified,
                indexStatus: " ",
                workTreeStatus: "M"
            )
        ))
        #expect(snapshot.files.contains(
            ChangedFile(
                path: "Untracked.txt",
                status: .untracked,
                indexStatus: "?",
                workTreeStatus: "?"
            )
        ))
        #expect(snapshot.allPatch.contains("diff --git a/Tracked.txt b/Tracked.txt"))
        #expect(snapshot.allPatch.contains("+two"))
        #expect(snapshot.allPatch.contains("diff --git a/Untracked.txt b/Untracked.txt"))
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "GitSnapshotServiceTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func runGit(_ arguments: [String], in directoryURL: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git"] + arguments
        process.currentDirectoryURL = directoryURL

        let errorPipe = Pipe()
        process.standardError = errorPipe

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let message = String(
                data: errorPipe.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            ) ?? ""
            throw TestGitError.commandFailed(arguments, message)
        }
    }
}

private enum TestGitError: Error {
    case commandFailed([String], String)
}
