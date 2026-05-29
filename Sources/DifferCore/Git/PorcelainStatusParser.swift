import Foundation

struct PorcelainStatusParser: Sendable {
    func parse(_ data: Data) throws -> [ChangedFile] {
        guard data.isEmpty == false else {
            return []
        }

        let records = data.split(separator: 0, omittingEmptySubsequences: true)
        var files: [ChangedFile] = []
        var index = 0

        while index < records.count {
            guard let record = String(data: Data(records[index]), encoding: .utf8),
                  record.count >= 4
            else {
                throw GitSnapshotError.invalidStatusOutput
            }

            let indexStatus = String(record[record.startIndex])
            let workTreeStatus = String(record[record.index(after: record.startIndex)])
            let pathStart = record.index(record.startIndex, offsetBy: 3)
            let path = String(record[pathStart...])

            var oldPath: String?
            if indexStatus == "R" || indexStatus == "C" {
                index += 1
                guard index < records.count,
                      let previousPath = String(data: Data(records[index]), encoding: .utf8)
                else {
                    throw GitSnapshotError.invalidStatusOutput
                }
                oldPath = previousPath
            }

            files.append(
                ChangedFile(
                    path: path,
                    oldPath: oldPath,
                    status: status(indexStatus: indexStatus, workTreeStatus: workTreeStatus),
                    indexStatus: indexStatus,
                    workTreeStatus: workTreeStatus
                )
            )

            index += 1
        }

        return files.sorted { left, right in
            left.path.localizedStandardCompare(right.path) == .orderedAscending
        }
    }

    private func status(indexStatus: String, workTreeStatus: String) -> GitFileStatus {
        if indexStatus == "?" && workTreeStatus == "?" {
            return .untracked
        }

        if indexStatus == "!" && workTreeStatus == "!" {
            return .ignored
        }

        if indexStatus == "U" || workTreeStatus == "U" {
            return .conflicted
        }

        if indexStatus == "R" || workTreeStatus == "R" {
            return .renamed
        }

        if indexStatus == "C" || workTreeStatus == "C" {
            return .copied
        }

        if indexStatus == "A" || workTreeStatus == "A" {
            return .added
        }

        if indexStatus == "D" || workTreeStatus == "D" {
            return .deleted
        }

        if indexStatus == "M" && workTreeStatus == " " {
            return .modified
        }

        if indexStatus == " " && workTreeStatus == "M" {
            return .modified
        }

        return .mixed
    }
}
