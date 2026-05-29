import AppKit
import SwiftUI

@main
@MainActor
final class DifferApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private static var delegateReference: DifferApp?

    private let appState = AppState()
    private let launchOptions = LaunchOptions.current()
    private var window: NSWindow?

    static func main() {
        let app = NSApplication.shared
        let delegate = DifferApp()

        delegateReference = delegate
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        showMainWindow()
        NSApp.activate()

        if let repositoryURL = launchOptions.repositoryURL {
            Task {
                await appState.openRepository(repositoryURL)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    @objc private func openRepositoryFromMenu() {
        guard let url = RepositoryPicker.chooseRepository() else {
            return
        }

        Task {
            await appState.openRepository(url)
        }
    }

    @objc private func zoomIn() {
        appState.setUiZoomPercent(appState.uiZoomPercent + 10)
    }

    @objc private func zoomOut() {
        appState.setUiZoomPercent(appState.uiZoomPercent - 10)
    }

    @objc private func resetZoom() {
        appState.setUiZoomPercent(100)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func showMainWindow() {
        if let window {
            window.makeKeyAndOrderFront(nil)
            return
        }

        let rootView = ContentView()
            .environmentObject(appState)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        window.title = "Differ"
        window.center()
        window.delegate = self
        window.contentViewController = NSHostingController(rootView: rootView)
        window.makeKeyAndOrderFront(nil)

        self.window = window
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        let quitItem = NSMenuItem(
            title: "Quit Differ",
            action: #selector(quit),
            keyEquivalent: "q"
        )
        quitItem.target = self
        appMenu.addItem(quitItem)
        mainMenu.addItem(appMenuItem)
        appMenuItem.submenu = appMenu

        let repositoryMenuItem = NSMenuItem()
        let repositoryMenu = NSMenu(title: "Repository")
        let openRepositoryItem = NSMenuItem(
            title: "Open Repository...",
            action: #selector(openRepositoryFromMenu),
            keyEquivalent: "o"
        )
        openRepositoryItem.target = self
        repositoryMenu.addItem(openRepositoryItem)
        repositoryMenuItem.submenu = repositoryMenu
        mainMenu.addItem(repositoryMenuItem)

        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        let zoomInItem = NSMenuItem(
            title: "Zoom In",
            action: #selector(zoomIn),
            keyEquivalent: "="
        )
        zoomInItem.target = self
        viewMenu.addItem(zoomInItem)

        let zoomOutItem = NSMenuItem(
            title: "Zoom Out",
            action: #selector(zoomOut),
            keyEquivalent: "-"
        )
        zoomOutItem.target = self
        viewMenu.addItem(zoomOutItem)

        let resetZoomItem = NSMenuItem(
            title: "Actual Size",
            action: #selector(resetZoom),
            keyEquivalent: "0"
        )
        resetZoomItem.target = self
        viewMenu.addItem(resetZoomItem)
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        NSApp.mainMenu = mainMenu
    }
}
