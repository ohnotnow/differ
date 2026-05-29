import Foundation
import Testing
@testable import DifferCore

@Suite("Porcelain status parser")
struct PorcelainStatusParserTests {
    @Test("parses modified, added, and untracked files")
    func parsesCommonStatuses() throws {
        let data = Data(" M Sources/App.swift\0A  Package.swift\0?? Notes.txt\0".utf8)

        let files = try PorcelainStatusParser().parse(data)

        #expect(files == [
            ChangedFile(
                path: "Notes.txt",
                status: .untracked,
                indexStatus: "?",
                workTreeStatus: "?"
            ),
            ChangedFile(
                path: "Package.swift",
                status: .added,
                indexStatus: "A",
                workTreeStatus: " "
            ),
            ChangedFile(
                path: "Sources/App.swift",
                status: .modified,
                indexStatus: " ",
                workTreeStatus: "M"
            ),
        ])
    }

    @Test("parses porcelain v1 z rename records")
    func parsesRename() throws {
        let data = Data("R  Sources/New.swift\0Sources/Old.swift\0".utf8)

        let files = try PorcelainStatusParser().parse(data)

        #expect(files == [
            ChangedFile(
                path: "Sources/New.swift",
                oldPath: "Sources/Old.swift",
                status: .renamed,
                indexStatus: "R",
                workTreeStatus: " "
            ),
        ])
    }
}
