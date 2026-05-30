import Foundation

enum AppIdentity {
    static let baseDisplayName = "Differ"

    static func displayName(for repositoryURL: URL?) -> String {
        guard let repositoryURL else {
            return baseDisplayName
        }

        let repositoryName = repositoryURL.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)

        guard repositoryName.isEmpty == false else {
            return "\(baseDisplayName) - \(repositoryURL.path)"
        }

        return "\(baseDisplayName) - \(repositoryName)"
    }
}
