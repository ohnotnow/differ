// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Differ",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(name: "DifferCore", targets: ["DifferCore"]),
        .executable(name: "Differ", targets: ["Differ"]),
    ],
    targets: [
        .target(name: "DifferCore"),
        .executableTarget(
            name: "Differ",
            dependencies: ["DifferCore"],
            resources: [
                .copy("Resources/Web"),
            ]
        ),
        .testTarget(
            name: "DifferCoreTests",
            dependencies: ["DifferCore"]
        ),
    ]
)
