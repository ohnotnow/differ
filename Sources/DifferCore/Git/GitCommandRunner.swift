import Foundation

struct GitCommandRunner: Sendable {
    func run(_ arguments: [String], in repositoryURL: URL) throws -> Data {
        try runProcess(arguments, maximumOutputBytes: nil, in: repositoryURL) ?? Data()
    }

    func run(_ arguments: [String], maximumOutputBytes: Int, in repositoryURL: URL) throws -> Data? {
        try runProcess(arguments, maximumOutputBytes: maximumOutputBytes, in: repositoryURL)
    }

    private func runProcess(_ arguments: [String], maximumOutputBytes: Int?, in repositoryURL: URL) throws -> Data? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git"] + arguments
        process.currentDirectoryURL = repositoryURL

        let temporaryDirectoryURL = FileManager.default.temporaryDirectory
            .appending(path: "DifferGitCommand-\(UUID().uuidString)", directoryHint: .isDirectory)
        let outputURL = temporaryDirectoryURL.appending(path: "stdout")
        let errorURL = temporaryDirectoryURL.appending(path: "stderr")

        try FileManager.default.createDirectory(at: temporaryDirectoryURL, withIntermediateDirectories: true)
        _ = FileManager.default.createFile(atPath: outputURL.path, contents: nil)
        _ = FileManager.default.createFile(atPath: errorURL.path, contents: nil)
        defer {
            try? FileManager.default.removeItem(at: temporaryDirectoryURL)
        }

        let outputHandle = try FileHandle(forWritingTo: outputURL)
        let errorHandle = try FileHandle(forWritingTo: errorURL)
        defer {
            outputHandle.closeFile()
            errorHandle.closeFile()
        }

        process.standardOutput = outputHandle
        process.standardError = errorHandle

        do {
            try process.run()
        } catch {
            throw GitSnapshotError.gitUnavailable(error.localizedDescription)
        }

        process.waitUntilExit()
        outputHandle.closeFile()
        errorHandle.closeFile()

        let errorData = try Data(contentsOf: errorURL)

        guard process.terminationStatus == 0 else {
            let message = String(data: errorData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)

            throw GitSnapshotError.gitCommandFailed(
                arguments: arguments,
                exitCode: process.terminationStatus,
                message: message ?? "git exited with status \(process.terminationStatus)"
            )
        }

        if let maximumOutputBytes,
           try fileSize(for: outputURL) > maximumOutputBytes
        {
            return nil
        }

        return try Data(contentsOf: outputURL)
    }

    private func fileSize(for url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = attributes[.size] as? NSNumber
        return size?.intValue ?? 0
    }
}
