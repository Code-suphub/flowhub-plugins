import Foundation
import IOKit.hid
import CryptoKit

// Wired K75 RGB 258a:0112. Writes are restricted to the verified configuration layout.
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

struct PresetChange {
    let expectedMode: UInt8
    let mode: UInt8
    let expectedLight: UInt8?
    let light: UInt8?

    init(_ arguments: ArraySlice<String>) throws {
        let values = Array(arguments)
        guard values.count == 4, let before = UInt8(values[0]), let after = UInt8(values[1]),
              [0, 1].contains(before), [0, 1].contains(after)
        else { throw ProbeError("无效的键位模式预设") }
        expectedMode = before
        mode = after
        if values[2] == "-" && values[3] == "-" {
            expectedLight = nil
            light = nil
        } else if let before = UInt8(values[2]), let after = UInt8(values[3]),
                  [2, 4].contains(before), [2, 4].contains(after) {
            expectedLight = before
            light = after
        } else {
            throw ProbeError("无效的灯效预设")
        }
    }

    func apply(to config: [UInt8], release: Int, device: IOHIDDevice) throws -> [UInt8] {
        guard release == 0x4023, config[9] == 0 else { throw ProbeError("此 USB 设备版本或预设布局未经验证") }
        guard config[0] == expectedMode, expectedLight == nil || config[10] == expectedLight
        else { throw ProbeError("键盘状态已变化，请读取最新状态后再应用") }
        var expected = config
        expected[0] = mode
        if let light { expected[10] = light }
        if config == expected { return config }
        let header: [UInt8] = [reportID, 0x04, 0, 0, 1, 0, 128, 0]
        let report = header + expected + [UInt8](repeating: 0, count: reportSize - header.count - expected.count)
        let result = IOHIDDeviceSetReport(device, kIOHIDReportTypeFeature, Int(reportID), report, report.count)
        guard result == kIOReturnSuccess else { throw ProbeError("K75 写入失败，请重新读取状态") }
        usleep(180_000)
        let actual = try Query.configuration.read(device)
        guard actual == expected else { throw ProbeError("K75 完整读回未匹配，请查看当前状态") }
        return actual
    }
}

func status(location: Int?, change: PresetChange? = nil, diagnostics: Bool = false) throws -> [String: Any] {
    let (device, release) = try findKeyboard(location: location)
    let open = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
    guard open == kIOReturnSuccess else { throw ProbeError("无法打开 K75 USB 厂商接口") }
    defer { IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone)) }
    var config = try Query.configuration.read(device)
    guard config.suffix(2).elementsEqual([0x5a, 0xa5]) else {
        throw ProbeError("K75 配置块标记不匹配")
    }
    if let change { config = try change.apply(to: config, release: release, device: device) }
    // K75 0x4023 switched 1 -> 0 -> 1 using the documented Fn+S / Fn+A shortcuts.
    let osMode: String
    switch (release, config[0]) {
    case (0x4023, 0): osMode = "windows"
    case (0x4023, 1): osMode = "mac"
    default: osMode = "unknown"
    }
    if location != nil {
        let compatible = release == 0x4023 && config[9] == 0
        let lighting = compatible ? ([2:"breathing",4:"off"][Int(config[10])] ?? "unknown") : "unknown"
        var report: [String: Any] = ["usbRelease": String(format: "0x%04x", release), "osMode": osMode,
                "lighting": lighting, "configurationSupported": compatible,
                "configurationDigest": SHA256.hash(data: Data(config)).map { String(format: "%02x", $0) }.joined()]
        if diagnostics {
            report["configurationBytes"] = config.count
            report["powerBytes"] = try? Query.power.read(device)
            if compatible { report["modeByte"] = config[0]; report["lightingByte"] = config[10] }
        }
        return report
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
    var change: PresetChange?
    if arguments.isEmpty {
        location = nil
    } else if arguments.count >= 2, let port = UInt32(arguments.dropFirst().first ?? ""), port != 0 {
        location = Int(port)
        switch (arguments.first, arguments.count) {
        case ("--mode-at", 2), ("--diagnostics-at", 2): break
        case ("--apply-at", 6): change = try PresetChange(arguments.dropFirst(2))
        default: throw ProbeError("K75 USB 诊断命令无效")
        }
    } else {
        throw ProbeError("K75 USB 位置参数无效")
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: status(
        location: location, change: change, diagnostics: arguments.first == "--diagnostics-at")))
} catch {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["error": error.localizedDescription]))
}
