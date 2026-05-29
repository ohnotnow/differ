import Foundation
import Testing
@testable import DifferCore

@Suite("Untracked patch builder")
struct UntrackedPatchBuilderTests {
    @Test("builds a new-file patch for utf8 files")
    func buildsTextPatch() throws {
        let rootURL = try temporaryDirectory()
        let nestedURL = rootURL.appending(path: "Sources")
        try FileManager.default.createDirectory(at: nestedURL, withIntermediateDirectories: true)
        try "hello\nworld\n".write(to: nestedURL.appending(path: "Note.txt"), atomically: true, encoding: .utf8)

        let patch = try UntrackedPatchBuilder().patch(for: "Sources/Note.txt", in: rootURL)

        #expect(patch.contains("diff --git a/Sources/Note.txt b/Sources/Note.txt"))
        #expect(patch.contains("new file mode 100644"))
        #expect(patch.contains("@@ -0,0 +1,3 @@"))
        #expect(patch.contains("+hello\n+world\n+"))
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "DifferCoreTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
