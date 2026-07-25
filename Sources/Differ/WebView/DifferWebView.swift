import Combine
import DifferCore
import AppKit
import SwiftUI
import WebKit

struct DifferWebView: NSViewRepresentable {
    let indexURL: URL
    let appState: AppState

    func makeCoordinator() -> Coordinator {
        Coordinator(appState: appState)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "differ")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        webView.setValue(false, forKey: "drawsBackground")
        webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard webView.url != indexURL else {
            return
        }

        webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?

        private let appState: AppState
        private var cancellables = Set<AnyCancellable>()
        private var isWebReady = false
        private let encoder: JSONEncoder = {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            return encoder
        }()

        init(appState: AppState) {
            self.appState = appState
            super.init()
            bindAppState()
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "differ" else {
                return
            }

            print("Differ web message:", message.body)
            handleWebMessage(message.body)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            let script = """
            JSON.stringify({
              href: window.location.href,
              stylesheets: document.styleSheets.length,
              scripts: document.scripts.length,
              differType: typeof window.Differ
            })
            """

            webView.evaluateJavaScript(script) { result, error in
                if let error {
                    print("Differ web diagnostics failed:", error.localizedDescription)
                    return
                }

                print("Differ web diagnostics:", result ?? "nil")
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("Differ web navigation failed:", error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("Differ web provisional navigation failed:", error.localizedDescription)
        }

        private func bindAppState() {
            appState.$snapshot
                .sink { [weak self] snapshot in
                    guard let snapshot else {
                        return
                    }

                    self?.sendSnapshot(snapshot)
                    self?.sendCurrentReviewerComments()
                }
                .store(in: &cancellables)

            appState.$selectedPatch
                .sink { [weak self] selectedPatch in
                    guard let selectedPatch else {
                        return
                    }

                    self?.sendSelectedPatch(selectedPatch)
                }
                .store(in: &cancellables)

            appState.$reviewerCommentsDocument
                .sink { [weak self] document in
                    guard let document else {
                        return
                    }

                    self?.sendReviewerComments(document)
                }
                .store(in: &cancellables)

            Publishers.CombineLatest4(
                appState.$refreshIntervalMilliseconds,
                appState.$isAutoRefreshEnabled,
                appState.$uiZoomPercent,
                appState.$sidebarWidthPoints
            )
                .combineLatest(
                    Publishers.CombineLatest3(
                        appState.$themeName,
                        appState.$fontFamilyName,
                        appState.$hiddenAllChangesPaths
                    )
                )
                // @Published emits in willSet, so re-reading appState here returns
                // the *previous* values. Use the values Combine emits instead, which
                // are the new ones — otherwise the echo reverts the web's optimistic
                // update (the "one change behind" bug).
                .sink { [weak self] values in
                    let ((interval, autoRefresh, zoom, sidebarWidth), (theme, fontFamily, hiddenAllChangesPaths)) = values
                    self?.sendPreferences(
                        refreshIntervalMilliseconds: interval,
                        autoRefreshEnabled: autoRefresh,
                        uiZoomPercent: zoom,
                        sidebarWidthPoints: sidebarWidth,
                        theme: theme,
                        fontFamily: fontFamily,
                        hiddenAllChangesPaths: hiddenAllChangesPaths
                    )
                }
                .store(in: &cancellables)
        }

        private func handleWebMessage(_ body: Any) {
            guard let message = body as? [String: Any],
                  let type = message["type"] as? String
            else {
                return
            }

            switch type {
            case "web-ready":
                isWebReady = true
                sendCurrentPreferences()
                if let snapshot = appState.snapshot {
                    sendSnapshot(snapshot)
                }
                sendCurrentReviewerComments()

            case "set-auto-refresh":
                guard let enabled = boolValue(from: message["enabled"]) else {
                    return
                }

                Task {
                    await appState.setAutoRefreshEnabled(enabled)
                }

            case "select-all":
                appState.selectAllChanges()

            case "select-file":
                guard let path = message["path"] as? String else {
                    return
                }

                Task {
                    await appState.selectFile(path: path)
                }

            case "set-refresh-interval":
                guard let milliseconds = intValue(from: message["milliseconds"]) else {
                    return
                }

                appState.setRefreshInterval(milliseconds: milliseconds)

            case "set-ui-zoom":
                guard let percent = intValue(from: message["percent"]) else {
                    return
                }

                appState.setUiZoomPercent(percent)

            case "set-sidebar-width":
                guard let points = intValue(from: message["points"]) else {
                    return
                }

                appState.setSidebarWidth(points: points)

            case "set-theme":
                guard let theme = message["theme"] as? String else {
                    return
                }

                appState.setTheme(theme)

            case "set-font-family":
                guard let fontFamily = message["fontFamily"] as? String else {
                    return
                }

                appState.setFontFamily(fontFamily)

            case "set-all-changes-path-hidden":
                guard let path = message["path"] as? String,
                      let hidden = boolValue(from: message["hidden"])
                else {
                    return
                }

                Task {
                    appState.setAllChangesPathHidden(path: path, hidden: hidden)
                    await appState.refreshSnapshot(showLoading: false)
                }

            case "copy-to-clipboard":
                guard let text = message["text"] as? String else {
                    return
                }

                copyToClipboard(text)

            case "create-comment":
                guard let draft = reviewerCommentDraft(from: message) else {
                    return
                }

                appState.createReviewerComment(
                    body: draft.body,
                    reference: draft.reference,
                    selection: draft.selection,
                    snippet: draft.snippet,
                    snapshotFingerprint: draft.snapshotFingerprint
                )

            case "update-comment":
                guard let id = message["id"] as? String,
                      let body = message["body"] as? String
                else {
                    return
                }

                appState.updateReviewerComment(id: id, body: body)

            case "resolve-comment":
                guard let id = message["id"] as? String else {
                    return
                }

                appState.resolveReviewerComment(id: id)

            case "reopen-comment":
                guard let id = message["id"] as? String else {
                    return
                }

                appState.reopenReviewerComment(id: id)

            case "delete-comment":
                guard let id = message["id"] as? String else {
                    return
                }

                appState.deleteReviewerComment(id: id)

            case "set-comment-placements":
                appState.setReviewerCommentPlacements(
                    reviewerCommentPlacementReports(from: message["placements"])
                )

            default:
                break
            }
        }

        private func copyToClipboard(_ text: String) {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
        }

        private func intValue(from value: Any?) -> Int? {
            switch value {
            case let int as Int:
                return int
            case let number as NSNumber:
                return number.intValue
            case let string as String:
                return Int(string)
            default:
                return nil
            }
        }

        private func boolValue(from value: Any?) -> Bool? {
            switch value {
            case let bool as Bool:
                return bool
            case let number as NSNumber:
                return number.boolValue
            case let string as String:
                return Bool(string)
            default:
                return nil
            }
        }

        private func reviewerCommentDraft(from message: [String: Any]) -> ReviewerCommentDraft? {
            guard let body = message["body"] as? String,
                  let reference = message["reference"] as? String,
                  let selection = reviewerCommentSelection(from: message["selection"])
            else {
                return nil
            }

            return ReviewerCommentDraft(
                body: body,
                reference: reference,
                selection: selection,
                snippet: message["snippet"] as? String,
                snapshotFingerprint: message["snapshotFingerprint"] as? String
            )
        }

        private func reviewerCommentSelection(from value: Any?) -> ReviewerCommentSelection? {
            guard let dictionary = value as? [String: Any],
                  let file = dictionary["file"] as? String,
                  let side = reviewerCommentSide(from: dictionary["side"]),
                  let startLine = intValue(from: dictionary["startLine"]),
                  let endLine = intValue(from: dictionary["endLine"])
            else {
                return nil
            }

            return ReviewerCommentSelection(
                file: file,
                oldFile: dictionary["oldFile"] as? String,
                side: side,
                startLine: startLine,
                endLine: endLine,
                endSide: reviewerCommentSide(from: dictionary["endSide"])
            )
        }

        private func reviewerCommentSide(from value: Any?) -> ReviewerCommentSide? {
            guard let string = value as? String else {
                return nil
            }

            return ReviewerCommentSide(rawValue: string)
        }

        private func reviewerCommentPlacementReports(from value: Any?) -> [ReviewerCommentPlacementReport] {
            guard let values = value as? [Any] else {
                return []
            }

            return values.compactMap { value in
                guard let dictionary = value as? [String: Any],
                      let id = dictionary["id"] as? String,
                      let status = reviewerCommentPlacementStatus(from: dictionary["status"])
                else {
                    return nil
                }

                return ReviewerCommentPlacementReport(
                    id: id,
                    status: status,
                    reason: dictionary["reason"] as? String
                )
            }
        }

        private func reviewerCommentPlacementStatus(from value: Any?) -> ReviewerCommentPlacementStatus? {
            guard let string = value as? String else {
                return nil
            }

            return ReviewerCommentPlacementStatus(rawValue: string)
        }

        private func sendSnapshot(_ snapshot: GitSnapshot) {
            guard isWebReady else {
                return
            }

            print("Differ native snapshot: \(snapshot.files.count) files, \(snapshot.allPatch.utf8.count) patch bytes")
            evaluateDifferCall(functionName: "applySnapshot", arguments: [snapshot])
        }

        private func sendSelectedPatch(_ selectedPatch: SelectedPatch) {
            guard isWebReady else {
                return
            }

            evaluateDifferCall(functionName: "applyPatch", arguments: [selectedPatch.path, selectedPatch.patch])
        }

        private func sendCurrentReviewerComments() {
            guard let document = appState.reviewerCommentsDocument else {
                return
            }

            sendReviewerComments(document)
        }

        private func sendReviewerComments(_ document: ReviewerCommentsDocument) {
            guard isWebReady else {
                return
            }

            evaluateDifferCall(functionName: "applyComments", arguments: [document])
        }

        private func sendCurrentPreferences() {
            sendPreferences(
                refreshIntervalMilliseconds: appState.refreshIntervalMilliseconds,
                autoRefreshEnabled: appState.isAutoRefreshEnabled,
                uiZoomPercent: appState.uiZoomPercent,
                sidebarWidthPoints: appState.sidebarWidthPoints,
                theme: appState.themeName,
                fontFamily: appState.fontFamilyName,
                hiddenAllChangesPaths: appState.hiddenAllChangesPaths
            )
        }

        private func sendPreferences(
            refreshIntervalMilliseconds: Int,
            autoRefreshEnabled: Bool,
            uiZoomPercent: Int,
            sidebarWidthPoints: Int,
            theme: String,
            fontFamily: String?,
            hiddenAllChangesPaths: [String]
        ) {
            guard isWebReady else {
                return
            }

            evaluateDifferCall(
                functionName: "applyPreferences",
                arguments: [
                    WebPreferences(
                        refreshIntervalMilliseconds: refreshIntervalMilliseconds,
                        autoRefreshEnabled: autoRefreshEnabled,
                        uiZoomPercent: uiZoomPercent,
                        sidebarWidthPoints: sidebarWidthPoints,
                        theme: theme,
                        fontFamily: fontFamily,
                        availableFontFamilies: appState.availableFontFamilies,
                        hiddenAllChangesPaths: hiddenAllChangesPaths
                    ),
                ]
            )
        }

        private func evaluateDifferCall(functionName: String, arguments: [Encodable]) {
            guard let webView else {
                return
            }

            do {
                let argumentSource = try arguments
                    .map { try jsonLiteral(for: $0) }
                    .joined(separator: ", ")
                let script = "window.Differ?.\(functionName)(\(argumentSource));"

                webView.evaluateJavaScript(script)
            } catch {
                appState.reportBridgeError(error.localizedDescription)
            }
        }

        private func jsonLiteral(for value: Encodable) throws -> String {
            let data = try encoder.encode(AnyEncodable(value))
            return String(data: data, encoding: .utf8) ?? "null"
        }
    }
}

private struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void

    init(_ wrapped: Encodable) {
        self.encodeValue = wrapped.encode(to:)
    }

    func encode(to encoder: Encoder) throws {
        try encodeValue(encoder)
    }
}

private struct WebPreferences: Encodable {
    let refreshIntervalMilliseconds: Int
    let autoRefreshEnabled: Bool
    let uiZoomPercent: Int
    let sidebarWidthPoints: Int
    let theme: String
    let fontFamily: String?
    let availableFontFamilies: [String]
    let hiddenAllChangesPaths: [String]
}

private struct ReviewerCommentDraft {
    let body: String
    let reference: String
    let selection: ReviewerCommentSelection
    let snippet: String?
    let snapshotFingerprint: String?
}
