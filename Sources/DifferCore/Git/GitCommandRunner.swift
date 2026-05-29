import Foundation

struct GitCommandRunner: Sendable {
    func run(_ arguments: [String], in repositoryURL: URL) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git"] + arguments
        process.currentDirectoryURL = repositoryURL

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        do {
            try process.run()
        } catch {
            throw GitSnapshotError.gitUnavailable(error.localizedDescription)
        }

        process.waitUntilExit()

        let output = outputPipe.fileHandleForReading.readDataToEndOfFile()
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()

        guard process.terminationStatus == 0 else {
            let message = String(data: errorData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)

            throw GitSnapshotError.gitCommandFailed(
                arguments: arguments,
                exitCode: process.terminationStatus,
                message: message ?? "git exited with status \(process.terminationStatus)"
            )
        }

        return output
    }
}
