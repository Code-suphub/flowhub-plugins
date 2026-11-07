import AppKit
import IOKit
import UniformTypeIdentifiers

func usbHidNames() -> [[String: Any]] {
    var iterator: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOHIDDevice"), &iterator)
            == KERN_SUCCESS else { return [] }
    defer { IOObjectRelease(iterator) }
    var rows: [[String: Any]] = []
    while rows.count < 128 {
        let service = IOIteratorNext(iterator)
        guard service != 0 else { break }
        defer { IOObjectRelease(service) }
        func property(_ key: String) -> CFTypeRef? {
            IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
        }
        guard let transport = property("Transport") as? String, transport == "USB",
              let vendor = property("VendorID") as? NSNumber,
              let product = property("ProductID") as? NSNumber,
              let location = property("LocationID") as? NSNumber, location.uint64Value != 0,
              let name = property("Product") as? String, !name.isEmpty else { continue }
        rows.append(["transport": transport, "vendor": vendor, "product": product,
                     "location": location, "name": String(name.prefix(92))])
    }
    return rows
}

if CommandLine.arguments.dropFirst().elementsEqual(["--usb-hid-names"]) {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: usbHidNames()))
    exit(EXIT_SUCCESS)
}

// Resolve installed system artwork, not a product-photo CDN or a wallpaper.
// Fixed family identifiers only; this helper never accepts device names or paths.
let families: [String: [String]] = [
    "iphone": ["com.apple.iphone"],
    "airpods-pro": ["com.apple.airpods-pro"],
    "airpods": ["com.apple.airpods"],
    "apple-mouse": ["com.apple.magic-mouse", "com.apple.mouse"],
    "apple-keyboard": ["com.apple.keyboard"],
    "macbook": ["com.apple.macbookpro", "com.apple.macbook"],
]

func png(_ image: NSImage) -> Data? {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 96,
        pixelsHigh: 96, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: 96, height: 96), from: .zero,
        operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])
}

var result: [String: [String: String]] = [:]
autoreleasepool {
    for (family, candidates) in families {
        for identifier in candidates {
            guard let type = UTType(identifier), type.isDeclared, !type.isDynamic,
                let data = png(NSWorkspace.shared.icon(for: type)), data.count < 65536 else { continue }
            result[family] = ["dataUrl": "data:image/png;base64," + data.base64EncodedString(),
                "source": "macos", "typeIdentifier": identifier]
            break
        }
    }
}
let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(output)
