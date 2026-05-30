import AppKit
import Combine
import SwiftUI

@main
@MainActor
final class DifferApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private static var delegateReference: DifferApp?

    private let appState = AppState()
    private let defaults = UserDefaults.standard
    private let launchOptions = LaunchOptions.current()
    private var repositoryIdentityCancellable: AnyCancellable?
    private var window: NSWindow?

    static func main() {
        let delegate = DifferApp()
        ProcessInfo.processInfo.processName = AppIdentity.displayName(for: delegate.initialRepositoryURL)

        let app = NSApplication.shared
        delegateReference = delegate
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        bindApplicationIdentity()
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

    func windowDidMove(_ notification: Notification) {
        saveMainWindowFrame(from: notification)
    }

    func windowDidResize(_ notification: Notification) {
        saveMainWindowFrame(from: notification)
    }

    func windowWillClose(_ notification: Notification) {
        saveMainWindowFrame(from: notification)
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

        let restoredFrame = restoredMainWindowFrame()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        window.title = AppIdentity.displayName(for: initialRepositoryURL)
        window.delegate = self
        window.contentViewController = NSHostingController(rootView: rootView)
        let targetFrame = restoredFrame ?? defaultMainWindowFrame()
        window.setFrame(targetFrame, display: false)
        window.makeKeyAndOrderFront(nil)
        window.setFrame(targetFrame, display: true)

        self.window = window
    }

    private var initialRepositoryURL: URL? {
        launchOptions.repositoryURL ?? appState.selectedRepositoryURL
    }

    private func bindApplicationIdentity() {
        applyApplicationDisplayName(for: initialRepositoryURL)

        repositoryIdentityCancellable = appState.$selectedRepositoryURL
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] repositoryURL in
                Task { @MainActor [weak self] in
                    self?.applyApplicationDisplayName(for: repositoryURL)
                }
            }
    }

    private func applyApplicationDisplayName(for repositoryURL: URL?) {
        let displayName = AppIdentity.displayName(for: repositoryURL)

        ProcessInfo.processInfo.processName = displayName
        window?.title = displayName
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

    private func saveMainWindowFrame(from notification: Notification) {
        guard let window = notification.object as? NSWindow,
              window === self.window,
              window.isMiniaturized == false
        else {
            return
        }

        defaults.set(NSStringFromRect(window.frame), forKey: DefaultsKey.mainWindowFrame)
    }

    private func restoredMainWindowFrame() -> NSRect? {
        guard let frameString = defaults.string(forKey: DefaultsKey.mainWindowFrame) else {
            return nil
        }

        let frame = NSRectFromString(frameString)
        guard frame.width > 0,
              frame.height > 0,
              NSScreen.screens.contains(where: { $0.visibleFrame.intersects(frame) })
        else {
            return nil
        }

        return frame
    }

    private func defaultMainWindowFrame() -> NSRect {
        let visibleFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1180, height: 760)
        let width = min(1180, visibleFrame.width)
        let height = min(760, visibleFrame.height)

        return NSRect(
            x: visibleFrame.midX - width / 2,
            y: visibleFrame.midY - height / 2,
            width: width,
            height: height
        ).integral
    }
}

private enum DefaultsKey {
    static let mainWindowFrame = "mainWindowFrame"
}
