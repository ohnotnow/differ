import AppKit
import Foundation

@MainActor
enum RepositoryPicker {
    static func chooseRepository() -> URL? {
        let panel = NSOpenPanel()
        panel.title = "Choose Repository"
        panel.message = "Select a Git working copy to inspect with Differ."
        panel.prompt = "Choose"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false

        guard panel.runModal() == .OK else {
            return nil
        }

        return panel.url
    }
}
