import Foundation

struct LaunchOptions {
    let repositoryURL: URL?

    static func current(
        arguments: [String] = CommandLine.arguments,
        currentDirectoryPath: String = FileManager.default.currentDirectoryPath
    ) -> LaunchOptions {
        let pathArgument = arguments.dropFirst().first { argument in
            argument.isEmpty == false && argument.hasPrefix("-") == false
        }

        return LaunchOptions(
            repositoryURL: pathArgument.map {
                repositoryURL(from: $0, currentDirectoryPath: currentDirectoryPath)
            }
        )
    }

    private static func repositoryURL(from path: String, currentDirectoryPath: String) -> URL {
        let expandedPath = NSString(string: path).expandingTildeInPath

        let url: URL
        if expandedPath.hasPrefix("/") {
            url = URL(fileURLWithPath: expandedPath, isDirectory: true)
        } else {
            url = URL(fileURLWithPath: currentDirectoryPath, isDirectory: true)
                .appending(path: expandedPath, directoryHint: .isDirectory)
        }

        return url.standardizedFileURL
    }
}
