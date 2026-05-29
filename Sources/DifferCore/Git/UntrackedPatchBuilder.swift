import Foundation

struct UntrackedPatchBuilder: Sendable {
    func patch(for relativePath: String, in repositoryURL: URL) throws -> String {
        let fileURL = repositoryURL.appending(path: relativePath)
        var isDirectory: ObjCBool = false

        guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory) else {
            throw GitSnapshotError.unreadableUntrackedFile(relativePath)
        }

        guard isDirectory.boolValue == false else {
            throw GitSnapshotError.unsupportedDirectorySelection(relativePath)
        }

        let data = try Data(contentsOf: fileURL)
        let mode = executableMode(for: fileURL)

        guard let contents = String(data: data, encoding: .utf8) else {
            return """
            diff --git a/\(relativePath) b/\(relativePath)
            new file mode \(mode)
            Binary files /dev/null and b/\(relativePath) differ

            """
        }

        let lines = contents.split(separator: "\n", omittingEmptySubsequences: false)
        var patch = """
        diff --git a/\(relativePath) b/\(relativePath)
        new file mode \(mode)
        --- /dev/null
        +++ b/\(relativePath)
        @@ -0,0 +1,\(lines.count) @@

        """

        patch += lines.map { "+\($0)" }.joined(separator: "\n")

        if contents.hasSuffix("\n") {
            patch += "\n"
        } else {
            patch += "\n\\ No newline at end of file\n"
        }

        return patch
    }

    private func executableMode(for fileURL: URL) -> String {
        guard FileManager.default.isExecutableFile(atPath: fileURL.path) else {
            return "100644"
        }

        return "100755"
    }
}
