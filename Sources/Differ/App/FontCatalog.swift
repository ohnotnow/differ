import AppKit
import Foundation

@MainActor
enum FontCatalog {
    static let sharedDefaults = UserDefaults(suiteName: "com.ohnotnow.differ.shared") ?? .standard

    static func availableMonospacedFamilies() -> [String] {
        let fontManager = NSFontManager.shared

        return fontManager.availableFontFamilies
            .filter { family in
                guard let members = fontManager.availableMembers(ofFontFamily: family) else {
                    return false
                }

                return members.contains { member in
                    guard let fontName = member.first as? String,
                          let font = NSFont(name: fontName, size: NSFont.systemFontSize)
                    else {
                        return false
                    }

                    return font.isFixedPitch
                }
            }
            .sorted { left, right in
                left.localizedStandardCompare(right) == .orderedAscending
            }
    }
}
