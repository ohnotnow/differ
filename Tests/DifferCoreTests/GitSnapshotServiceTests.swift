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
        let untrackedFile = try #require(snapshot.files.first { $0.path == "Untracked.txt" })
        #expect(untrackedFile.status == .untracked)
        #expect(untrackedFile.indexStatus == "?")
        #expect(untrackedFile.workTreeStatus == "?")
        #expect(untrackedFile.contents == "new\n")
        #expect(snapshot.allPatch.contains("diff --git a/Tracked.txt b/Tracked.txt"))
        #expect(snapshot.allPatch.contains("+two"))
        #expect(snapshot.allPatch.contains("diff --git a/Untracked.txt b/Untracked.txt"))
    }

    @Test("captures changes before the first commit")
    func capturesChangesBeforeFirstCommit() throws {
        let rootURL = try temporaryDirectory()
        try runGit(["init"], in: rootURL)

        try "staged\n".write(to: rootURL.appending(path: "Staged.txt"), atomically: true, encoding: .utf8)
        try runGit(["add", "Staged.txt"], in: rootURL)
        try "new\n".write(to: rootURL.appending(path: "Untracked.txt"), atomically: true, encoding: .utf8)

        let service = GitSnapshotService()
        let snapshot = try service.snapshot(for: rootURL)

        #expect(snapshot.files.contains(
            ChangedFile(
                path: "Staged.txt",
                status: .added,
                indexStatus: "A",
                workTreeStatus: " "
            )
        ))
        #expect(snapshot.files.contains { $0.path == "Untracked.txt" && $0.status == .untracked })
        #expect(snapshot.allPatch.contains("diff --git a/Staged.txt b/Staged.txt"))
        #expect(snapshot.allPatch.contains("diff --git a/Untracked.txt b/Untracked.txt"))

        let stagedFile = try #require(snapshot.files.first { $0.path == "Staged.txt" })
        #expect(try service.patch(for: .file(stagedFile), in: rootURL).contains("+staged"))
    }

    @Test("omits oversized untracked content from preview patches")
    func omitsOversizedUntrackedContent() throws {
        let rootURL = try temporaryDirectory()
        try runGit(["init"], in: rootURL)
        try runGit(["config", "user.name", "Differ Tests"], in: rootURL)
        try runGit(["config", "user.email", "differ@example.test"], in: rootURL)
        try runGit(["commit", "--allow-empty", "-m", "Initial commit"], in: rootURL)

        let largeText = String(repeating: "x", count: 600_000)
        try largeText.write(to: rootURL.appending(path: "Large.txt"), atomically: true, encoding: .utf8)

        let service = GitSnapshotService()
        let snapshot = try service.snapshot(for: rootURL)
        let file = try #require(snapshot.files.first { $0.path == "Large.txt" })

        #expect(file.status == .untracked)
        #expect(file.contents == nil)
        #expect(snapshot.allPatch.isEmpty)
        #expect(try service.patch(for: .file(file), in: rootURL).isEmpty)
    }

    @Test("omits oversized tracked patches without blocking snapshots")
    func omitsOversizedTrackedPatches() throws {
        let rootURL = try temporaryDirectory()
        try runGit(["init"], in: rootURL)
        try runGit(["config", "user.name", "Differ Tests"], in: rootURL)
        try runGit(["config", "user.email", "differ@example.test"], in: rootURL)

        try "small\n".write(to: rootURL.appending(path: "Tracked.txt"), atomically: true, encoding: .utf8)
        try runGit(["add", "Tracked.txt"], in: rootURL)
        try runGit(["commit", "-m", "Initial commit"], in: rootURL)

        let largeText = String(repeating: "x", count: 2_200_000)
        try largeText.write(to: rootURL.appending(path: "Tracked.txt"), atomically: true, encoding: .utf8)

        let service = GitSnapshotService()
        let snapshot = try service.snapshot(for: rootURL)
        let file = try #require(snapshot.files.first { $0.path == "Tracked.txt" })

        #expect(file.status == .modified)
        #expect(snapshot.allPatch.isEmpty)
        #expect(try service.patch(for: .file(file), in: rootURL).isEmpty)
    }

    @Test("global patch keeps small diffs when other files are oversized")
    func globalPatchKeepsSmallDiffsWhenOtherFilesAreOversized() throws {
        let rootURL = try temporaryDirectory()
        try runGit(["init"], in: rootURL)
        try runGit(["config", "user.name", "Differ Tests"], in: rootURL)
        try runGit(["config", "user.email", "differ@example.test"], in: rootURL)

        try "small\n".write(to: rootURL.appending(path: "Small.txt"), atomically: true, encoding: .utf8)
        try "large\n".write(to: rootURL.appending(path: "Large.txt"), atomically: true, encoding: .utf8)
        try runGit(["add", "Small.txt", "Large.txt"], in: rootURL)
        try runGit(["commit", "-m", "Initial commit"], in: rootURL)

        try "small\nchanged\n".write(to: rootURL.appending(path: "Small.txt"), atomically: true, encoding: .utf8)
        let largeText = String(repeating: "x", count: 600_000)
        try largeText.write(to: rootURL.appending(path: "Large.txt"), atomically: true, encoding: .utf8)

        let snapshot = try GitSnapshotService().snapshot(for: rootURL)

        #expect(snapshot.files.contains { $0.path == "Small.txt" && $0.status == .modified })
        #expect(snapshot.files.contains { $0.path == "Large.txt" && $0.status == .modified })
        #expect(snapshot.allPatch.contains("diff --git a/Small.txt b/Small.txt"))
        #expect(snapshot.allPatch.contains("+changed"))
        #expect(snapshot.allPatch.contains("diff --git a/Large.txt b/Large.txt") == false)
    }

    @Test("global patch can exclude selected paths while keeping file status")
    func globalPatchCanExcludeSelectedPathsWhileKeepingFileStatus() throws {
        let rootURL = try temporaryDirectory()
        try runGit(["init"], in: rootURL)
        try runGit(["config", "user.name", "Differ Tests"], in: rootURL)
        try runGit(["config", "user.email", "differ@example.test"], in: rootURL)

        try "one\n".write(to: rootURL.appending(path: "README.md"), atomically: true, encoding: .utf8)
        try "two\n".write(to: rootURL.appending(path: "Sources.swift"), atomically: true, encoding: .utf8)
        try runGit(["add", "README.md", "Sources.swift"], in: rootURL)
        try runGit(["commit", "-m", "Initial commit"], in: rootURL)

        try "one\nignored for now\n".write(to: rootURL.appending(path: "README.md"), atomically: true, encoding: .utf8)
        try "two\nimportant\n".write(to: rootURL.appending(path: "Sources.swift"), atomically: true, encoding: .utf8)

        let snapshot = try GitSnapshotService().snapshot(for: rootURL, excludingPaths: ["README.md"])

        #expect(snapshot.files.contains { $0.path == "README.md" && $0.status == .modified })
        #expect(snapshot.files.contains { $0.path == "Sources.swift" && $0.status == .modified })
        #expect(snapshot.allPatch.contains("diff --git a/README.md b/README.md") == false)
        #expect(snapshot.allPatch.contains("diff --git a/Sources.swift b/Sources.swift"))
        #expect(snapshot.allPatch.contains("+important"))
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
