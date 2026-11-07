import Foundation
import IOKit.hid

// Verified on wired K75 RGB 258a:0112. A feature report is sent to request
// the response, but this helper only implements the two read commands.
let reportID: UInt8 = 0x06
let reportSize = 520
let collection: [UInt8] = [
    0x06, 0x00, 0xff, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x06, 0x15, 0x00,
    0x26, 0xff, 0x00, 0x19, 0x01, 0x29, 0x02, 0x75, 0x08, 0x96, 0x07,
    0x02, 0xb1, 0x02, 0xc0,
]

struct ProbeError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

func findKeyboard(location: Int?) throws -> (IOHIDDevice, Int) {
    var iterator: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOHIDDevice"), &iterator)
            == KERN_SUCCESS else { throw ProbeError("无法枚举 USB HID 设备") }
    defer { IOObjectRelease(iterator) }
    var matches: [(IOHIDDevice, Int)] = []
    while true {
        let service = IOIteratorNext(iterator)
        guard service != 0 else { break }
        defer { IOObjectRelease(service) }
        func property(_ key: String) -> CFTypeRef? {
            IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
        }
        guard property("Transport") as? String == "USB",
              property("VendorID") as? Int == 0x258a,
              property("ProductID") as? Int == 0x0112,
              location == nil || property("LocationID") as? Int == location,
              property("MaxFeatureReportSize") as? Int == reportSize,
              let descriptor = property("ReportDescriptor") as? Data,
              descriptor.range(of: Data(collection)) != nil,
              let release = property("VersionNumber") as? Int,
              let device = IOHIDDeviceCreate(kCFAllocatorDefault, service)
        else { continue }
        matches.append((device, release))
    }
    guard matches.count == 1, let match = matches.first else {
        throw ProbeError(matches.isEmpty ? "找不到有线 K75 RGB 258a:0112" : "有多把匹配键盘，请仅连接目标 K75")
    }
    return match
}

enum Query: UInt8 {
    case configuration = 0x84
    case power = 0x87

    var length: UInt8 { self == .configuration ? 128 : 2 }

    func read(_ device: IOHIDDevice) throws -> [UInt8] {
        let header = [reportID, rawValue, 0, 0, 1, 0, length, 0]
        let request = header + [UInt8](repeating: 0, count: reportSize - header.count)
        let write = IOHIDDeviceSetReport(device, kIOHIDReportTypeFeature, Int(reportID), request, request.count)
        guard write == kIOReturnSuccess else {
            throw ProbeError(String(format: "K75 查询发送失败 (0x%08x)", UInt32(bitPattern: write)))
        }
        usleep(25_000)
        var reply = [UInt8](repeating: 0, count: reportSize)
        reply[0] = reportID
        var lengthRead = reply.count
        let read = IOHIDDeviceGetReport(device, kIOHIDReportTypeFeature, Int(reportID), &reply, &lengthRead)
        guard read == kIOReturnSuccess, lengthRead == header.count + Int(length),
              reply.prefix(header.count).elementsEqual(header) else {
            throw ProbeError("K75 查询回包的命令或长度不匹配")
        }
        return Array(reply[header.count..<lengthRead])
    }
}

func status(location: Int?) throws -> [String: Any] {
    let (device, release) = try findKeyboard(location: location)
    let open = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
    guard open == kIOReturnSuccess else { throw ProbeError("无法打开 K75 USB 厂商接口") }
    defer { IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone)) }
    let config = try Query.configuration.read(device)
    guard config.suffix(2).elementsEqual([0x5a, 0xa5]) else {
        throw ProbeError("K75 配置块标记不匹配")
    }
    // K75 0x4023 switched 1 -> 0 -> 1 using the documented Fn+S / Fn+A shortcuts.
    let osMode: String
    switch (release, config[0]) {
    case (0x4023, 0): osMode = "windows"
    case (0x4023, 1): osMode = "mac"
    default: osMode = "unknown"
    }
    if location != nil {
        return ["usbRelease": String(format: "0x%04x", release), "osMode": osMode]
    }
    return [
        "model": "KZZI K75 RGB", "usbId": "258a:0112",
        "usbRelease": String(format: "0x%04x", release),
        "configurationBytes": config.count,
        "configurationModeBytes": [config[9], config[10], config[59]],
        "osMode": osMode, "osModeByte": config[0],
        "powerBytes": try Query.power.read(device),
    ]
}

do {
    let arguments = CommandLine.arguments.dropFirst()
    let location: Int?
    if arguments.isEmpty {
        location = nil
    } else if arguments.count == 2, arguments.first == "--mode-at",
              let port = UInt32(arguments.last ?? ""), port != 0 {
        location = Int(port)
    } else {
        throw ProbeError("K75 USB 位置参数无效")
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: status(location: location)))
} catch {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["error": error.localizedDescription]))
}
