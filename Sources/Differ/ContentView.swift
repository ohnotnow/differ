import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var appState: AppState

    private let webRootURL: URL?

    init(webRootURL: URL? = ContentView.defaultWebRootURL()) {
        self.webRootURL = webRootURL
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar

            Divider()

            if let webRootURL {
                DifferWebView(indexURL: webRootURL, appState: appState)
                    .frame(minWidth: 900, minHeight: 620)
            } else {
                missingWebAssetsView
                    .frame(minWidth: 900, minHeight: 620)
            }
        }
        .task {
            await appState.runPollingLoop()
        }
    }

    private static func defaultWebRootURL() -> URL? {
        Bundle.module.url(forResource: "index", withExtension: "html", subdirectory: "Web")
            ?? Bundle.module.url(forResource: "index", withExtension: "html")
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            Button {
                if let url = RepositoryPicker.chooseRepository() {
                    Task {
                        await appState.openRepository(url)
                    }
                }
            } label: {
                Label("Open Repository", systemImage: "folder")
            }

            Text(appState.selectedRepositoryDisplayName)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            if appState.isLoading {
                ProgressView()
                    .controlSize(.small)
            }

            if let errorMessage = appState.errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var missingWebAssetsView: some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(.orange)

            Text("Web assets are missing")
                .font(.headline)

            Text("Run npm run build:web, then launch Differ again.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
}
