// scanhelper — bridges the Feeder web server to macOS ImageCaptureCore.
//
//   scanhelper list
//   scanhelper info [--device <id|name>]
//   scanhelper scan --out <dir> [--device <id|name>] [--resolution 300]
//                   [--mode color|gray|bw] [--paper a4|letter|legal|tcg]
//                   [--source feeder|flatbed] [--duplex]
//   scanhelper pdf --out <file.pdf> <image>...
//
// Every command writes newline-delimited JSON events to stdout.
// SIGTERM/SIGINT during a scan cancels it and closes the device session cleanly.

import Foundation
import ImageCaptureCore
import ImageIO
import UniformTypeIdentifiers

// MARK: - Output

func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
    FileHandle.standardOutput.write(data + Data([0x0A]))
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

// MARK: - Arguments

struct Options {
    var command = ""
    var values: [String: String] = [:]
    var flags: Set<String> = []
    var rest: [String] = []

    init(_ argv: [String]) {
        var args = argv.dropFirst().makeIterator()
        command = args.next() ?? ""
        while let arg = args.next() {
            if arg == "--duplex" {
                flags.insert("duplex")
            } else if arg.hasPrefix("--"), let value = args.next() {
                values[String(arg.dropFirst(2))] = value
            } else {
                rest.append(arg)
            }
        }
    }

    subscript(key: String) -> String? { values[key] }
}

// MARK: - Device discovery

final class DeviceFinder: NSObject, ICDeviceBrowserDelegate {
    private let browser = ICDeviceBrowser()
    private(set) var scanners: [ICScannerDevice] = []
    private(set) var enumerated = false
    var onChange: (() -> Void)?

    override init() {
        super.init()
        browser.delegate = self
        let mask = ICDeviceTypeMask.scanner.rawValue | ICDeviceLocationTypeMask.local.rawValue
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: mask)!
        browser.start()
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        if let scanner = device as? ICScannerDevice { scanners.append(scanner) }
        onChange?()
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        scanners.removeAll { $0 == device }
        onChange?()
    }

    func deviceBrowserDidEnumerateLocalDevices(_ browser: ICDeviceBrowser) {
        enumerated = true
        onChange?()
    }

    func match(_ query: String?) -> ICScannerDevice? {
        guard let query, !query.isEmpty else { return scanners.first }
        return scanners.first { $0.uuidString == query || $0.name == query }
    }
}

func describe(_ scanner: ICScannerDevice) -> [String: Any] {
    [
        "id": scanner.uuidString ?? scanner.name ?? "",
        "name": scanner.name ?? "Scanner",
        "transport": (scanner.transportType ?? "").replacingOccurrences(of: "ICTransportType", with: ""),
    ]
}

/// Waits until a scanner matching `query` shows up, then hands it to `body`.
func withScanner(_ finder: DeviceFinder, _ query: String?, timeout: TimeInterval, _ body: @escaping (ICScannerDevice) -> Void) {
    var found = false
    finder.onChange = {
        guard !found, let scanner = finder.match(query) else { return }
        found = true
        body(scanner)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
        guard !found else { return }
        if let query, !query.isEmpty {
            fail("Scanner \"\(query)\" was not found. Check that it is plugged in and switched on.")
        }
        fail("No scanner found. Check that it is plugged in and switched on.")
    }
}

// MARK: - Scanning

struct ScanSettings {
    var resolution = 300
    var mode = "color"      // color | gray | bw
    var paper = "a4"        // a4 | letter | legal | tcg
    var source = "feeder"   // feeder | flatbed
    var duplex = false
    var outDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    var infoOnly = false
}

final class ScanSession: NSObject, ICScannerDeviceDelegate {
    private enum Phase { case opening, selecting, scanning, closing }

    private let scanner: ICScannerDevice
    private let settings: ScanSettings
    private var phase = Phase.opening
    private var wantedUnit = ICScannerFunctionalUnitType.documentFeeder
    private var pages = 0
    private var cancelled = false
    private var failure: String?
    private var progressTimer: Timer?

    init(scanner: ICScannerDevice, settings: ScanSettings) {
        self.scanner = scanner
        self.settings = settings
    }

    func start() {
        scanner.delegate = self
        emit(["type": "status", "message": "Connecting to \(scanner.name ?? "scanner")…", "device": describe(scanner)])
        scanner.requestOpenSession()
    }

    func cancel() {
        cancelled = true
        switch phase {
        case .scanning:
            emit(["type": "status", "message": "Cancelling…"])
            scanner.cancelScan()
        case .opening, .selecting:
            close()
        case .closing:
            break
        }
    }

    // MARK: Session lifecycle

    func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {
        if let error { fail(explain(error, fallback: "Could not connect to the scanner")) }
        // Scanners report readiness separately; don't wait forever if a driver never does.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.selectFunctionalUnit() }
    }

    func deviceDidBecomeReady(_ device: ICDevice) {
        selectFunctionalUnit()
    }

    func scannerDeviceDidBecomeAvailable(_ scanner: ICScannerDevice) {
        // Fired when another app releases a scanner we failed to open earlier.
        emit(["type": "status", "message": "Scanner is available again."])
    }

    func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {
        terminate()
    }

    func didRemove(_ device: ICDevice) {
        if pages == 0 && !cancelled { failure = "The scanner was disconnected." }
        terminate()
    }

    func device(_ device: ICDevice, didEncounterError error: Error?) {
        if let error { emit(["type": "warning", "message": explain(error, fallback: "Scanner reported an error")]) }
    }

    func device(_ device: ICDevice, didReceiveStatusInformation status: [ICDeviceStatus: Any]) {
        let message = status.first { $0.key.rawValue.contains("Localized") }?.value as? String
        if let message, !message.isEmpty { emit(["type": "status", "message": message]) }
    }

    // MARK: Functional unit (feeder / flatbed)

    private func selectFunctionalUnit() {
        guard phase == .opening else { return }
        phase = .selecting
        let available = scanner.availableFunctionalUnitTypes.compactMap { ICScannerFunctionalUnitType(rawValue: $0.uintValue) }
        let preferred: ICScannerFunctionalUnitType = settings.source == "flatbed" ? .flatbed : .documentFeeder
        wantedUnit = available.contains(preferred) ? preferred : (available.first ?? preferred)
        scanner.requestSelect(wantedUnit)
    }

    func scannerDevice(_ scanner: ICScannerDevice, didSelect functionalUnit: ICScannerFunctionalUnit, error: Error?) {
        // Drivers may also announce their default unit while the session opens; only act on ours.
        guard phase == .selecting else { return }
        if let error { failure = explain(error, fallback: "Could not select the document feeder"); close(); return }
        guard functionalUnit.type == wantedUnit else { return }
        settings.infoOnly ? reportInfo(functionalUnit) : startScan(functionalUnit)
    }

    private func configure(_ unit: ICScannerFunctionalUnit) {
        unit.measurementUnit = .inches
        unit.resolution = closest(settings.resolution, in: unit.supportedResolutions)

        switch settings.mode {
        case "bw" where unit.supportedBitDepths.contains(1):
            unit.pixelDataType = .BW
            unit.bitDepth = .depth1Bit
        case "gray", "bw":
            unit.pixelDataType = .gray
            unit.bitDepth = .depth8Bits
        default:
            unit.pixelDataType = .RGB
            unit.bitDepth = .depth8Bits
        }

        let paper = documentType(settings.paper)
        if let feeder = unit as? ICScannerFunctionalUnitDocumentFeeder {
            if settings.paper == "tcg" {
                selectCardSize(feeder)
            } else if feeder.supportedDocumentTypes.contains(Int(paper.rawValue)) {
                feeder.documentType = paper
            }
            feeder.duplexScanningEnabled = settings.duplex && feeder.supportsDuplexScanning
        } else if let flatbed = unit as? ICScannerFunctionalUnitFlatbed {
            if settings.paper == "tcg" {
                // Cards go in the platen's corner, so scan just that corner.
                unit.scanArea = NSRect(origin: .zero, size: cardWithMargin)
            } else if flatbed.supportedDocumentTypes.contains(Int(paper.rawValue)) {
                flatbed.documentType = paper
                unit.scanArea = NSRect(origin: .zero, size: flatbed.documentSize)
            } else {
                unit.scanArea = NSRect(origin: .zero, size: unit.physicalSize)
            }
        }
    }

    /// Feeders only take preset page sizes, so pick the smallest one that fits a card plus its margin.
    private func selectCardSize(_ feeder: ICScannerFunctionalUnitDocumentFeeder) {
        let fitting = documentSizes(feeder).filter {
            $0.size.width >= cardWithMargin.width && $0.size.height >= cardWithMargin.height
        }
        guard let best = fitting.min(by: { $0.size.width * $0.size.height < $1.size.width * $1.size.height }) else {
            emit(["type": "warning", "message": "This scanner has no page size large enough for a card, so its default size is used."])
            return
        }
        feeder.documentType = best.type
        if best.size.width * best.size.height > 2 * cardWithMargin.width * cardWithMargin.height {
            let mm = "\(Int((best.size.width * 25.4).rounded())) × \(Int((best.size.height * 25.4).rounded())) mm"
            emit(["type": "warning", "message": "This scanner has no card-sized page option, so each card is scanned on a \(mm) page."])
        }
    }

    private func startScan(_ unit: ICScannerFunctionalUnit) {
        phase = .scanning
        configure(unit)

        scanner.transferMode = .fileBased
        scanner.downloadsDirectory = settings.outDir
        scanner.documentName = "page"
        scanner.documentUTI = (settings.mode == "bw" ? UTType.png : UTType.jpeg).identifier

        let duplex = (unit as? ICScannerFunctionalUnitDocumentFeeder)?.duplexScanningEnabled ?? false
        emit(["type": "status", "message": "Scanning…", "resolution": unit.resolution, "duplex": duplex])

        var lastPercent = -1
        progressTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak unit] _ in
            guard let unit else { return }
            let percent = Int(unit.scanProgressPercentDone.rounded())
            if percent != lastPercent {
                lastPercent = percent
                emit(["type": "progress", "percent": percent])
            }
        }
        scanner.requestScan()
    }

    func scannerDevice(_ scanner: ICScannerDevice, didScanTo url: URL) {
        pages += 1
        emit(["type": "page", "path": url.path, "index": pages, "resolution": scanner.selectedFunctionalUnit.resolution])
    }

    func scannerDevice(_ scanner: ICScannerDevice, didCompleteScanWithError error: Error?) {
        progressTimer?.invalidate()
        if !cancelled {
            if let error {
                let message = explain(error, fallback: "The scan did not complete")
                if pages == 0 { failure = message } else { emit(["type": "warning", "message": message]) }
            } else if pages == 0 {
                failure = "No pages were scanned. Check that paper is loaded in the feeder."
            }
        }
        close()
    }

    private func reportInfo(_ unit: ICScannerFunctionalUnit) {
        unit.measurementUnit = .inches
        var info: [String: Any] = [
            "type": "info",
            "device": describe(scanner),
            "units": scanner.availableFunctionalUnitTypes.map { unitName($0.uintValue) },
            "selectedUnit": unitName(unit.type.rawValue),
            "resolutions": Array(unit.supportedResolutions),
            "preferredResolutions": Array(unit.preferredResolutions),
            "bitDepths": Array(unit.supportedBitDepths),
            "physicalSizeInches": [unit.physicalSize.width, unit.physicalSize.height],
            "vendorFeatures": (unit.vendorFeatures ?? []).map { $0.humanReadableName ?? $0.internalName ?? "?" },
        ]
        if let feeder = unit as? ICScannerFunctionalUnitDocumentFeeder {
            info["documentTypes"] = Array(feeder.supportedDocumentTypes)
            info["documentSizesMm"] = documentSizes(feeder).map {
                ["type": $0.type.rawValue, "size": [($0.size.width * 25.4).rounded(), ($0.size.height * 25.4).rounded()]]
            }
            info["supportsDuplex"] = feeder.supportsDuplexScanning
            info["documentLoaded"] = feeder.documentLoaded
        }
        emit(info)
        close()
    }

    // MARK: Teardown

    private func close() {
        guard phase != .closing else { return }
        phase = .closing
        progressTimer?.invalidate()
        scanner.requestCloseSession()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.terminate() }
    }

    private func terminate() -> Never {
        if let failure { fail(failure) }
        if !settings.infoOnly { emit(["type": "done", "pages": pages, "cancelled": cancelled]) }
        exit(0)
    }
}

func closest(_ target: Int, in values: IndexSet) -> Int {
    values.min { abs($0 - target) < abs($1 - target) } ?? target
}

func documentType(_ paper: String) -> ICScannerDocumentType {
    switch paper {
    case "letter": return .typeUSLetter
    case "legal": return .typeUSLegal
    default: return .typeA4
    }
}

/// A trading card is 63 × 88 mm. The extra 5 mm on every side keeps a slightly skewed card from being clipped.
let cardWithMargin = NSSize(width: 73 / 25.4, height: 98 / 25.4) // inches

/// The page sizes a feeder offers, in its current measurement unit, as reported by the driver.
func documentSizes(_ feeder: ICScannerFunctionalUnitDocumentFeeder) -> [(type: ICScannerDocumentType, size: NSSize)] {
    let original = feeder.documentType
    defer { feeder.documentType = original }
    return feeder.supportedDocumentTypes.compactMap { raw in
        guard raw != 0, let type = ICScannerDocumentType(rawValue: UInt(raw)) else { return nil }
        feeder.documentType = type
        return (type, feeder.documentSize)
    }
}

func unitName(_ raw: UInt) -> String {
    switch ICScannerFunctionalUnitType(rawValue: raw) {
    case .flatbed: return "flatbed"
    case .documentFeeder: return "feeder"
    case .positiveTransparency: return "positiveTransparency"
    case .negativeTransparency: return "negativeTransparency"
    default: return "unknown"
    }
}

func explain(_ error: Error, fallback: String) -> String {
    let code = (error as NSError).code
    switch code {
    case -9924, -9925: return "The scanner is in use by another app. Close HP Easy Scan or Image Capture and try again."
    case -9923: return "The scanner did not respond in time. Try switching it off and on again."
    case -9945: return "The scanner driver is not installed. Install HP Easy Scan from hp.com."
    default:
        let description = error.localizedDescription
        return description.isEmpty ? "\(fallback) (error \(code))." : "\(fallback): \(description) (error \(code))"
    }
}

// MARK: - PDF

func makePDF(at output: URL, from images: [URL]) {
    guard let context = CGContext(output as CFURL, mediaBox: nil, nil) else { fail("Could not create \(output.path)") }
    for url in images {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { fail("Could not read \(url.lastPathComponent)") }
        // Size each page from the scan's DPI so it prints at its real size.
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        let dpiX = (props[kCGImagePropertyDPIWidth] as? Double).flatMap { $0 > 1 ? $0 : nil } ?? 300
        let dpiY = (props[kCGImagePropertyDPIHeight] as? Double).flatMap { $0 > 1 ? $0 : nil } ?? dpiX
        var box = CGRect(x: 0, y: 0, width: Double(image.width) * 72 / dpiX, height: Double(image.height) * 72 / dpiY)
        context.beginPage(mediaBox: &box)
        context.draw(image, in: box)
        context.endPage()
    }
    context.closePDF()
}

// MARK: - Main

let options = Options(CommandLine.arguments)
var finder: DeviceFinder?
var session: ScanSession?

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        guard let session else { exit(130) }
        session.cancel()
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { exit(130) }
    }
    source.resume()
    signalSources.append(source)
}

switch options.command {
case "list":
    let browser = DeviceFinder()
    finder = browser
    let report = {
        emit(["type": "devices", "devices": browser.scanners.map(describe)])
        exit(0)
    }
    browser.onChange = {
        if browser.enumerated { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: report) }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + (Double(options["timeout"] ?? "") ?? 5), execute: report)

case "scan", "info":
    var settings = ScanSettings()
    settings.infoOnly = options.command == "info"
    settings.resolution = Int(options["resolution"] ?? "") ?? 300
    settings.mode = options["mode"] ?? "color"
    settings.paper = options["paper"] ?? "a4"
    settings.source = options["source"] ?? "feeder"
    settings.duplex = options.flags.contains("duplex")
    if let out = options["out"] {
        settings.outDir = URL(fileURLWithPath: out, isDirectory: true)
        try? FileManager.default.createDirectory(at: settings.outDir, withIntermediateDirectories: true)
    } else if !settings.infoOnly {
        fail("Missing --out <dir>")
    }

    emit(["type": "status", "message": "Looking for scanner…"])
    let browser = DeviceFinder()
    finder = browser
    withScanner(browser, options["device"], timeout: 10) { scanner in
        let job = ScanSession(scanner: scanner, settings: settings)
        session = job
        job.start()
    }

case "pdf":
    guard let out = options["out"], !options.rest.isEmpty else { fail("Usage: scanhelper pdf --out <file.pdf> <image>...") }
    makePDF(at: URL(fileURLWithPath: out), from: options.rest.map { URL(fileURLWithPath: $0) })
    emit(["type": "done", "path": out, "pages": options.rest.count])
    exit(0)

default:
    FileHandle.standardError.write("usage: scanhelper list | info | scan --out <dir> | pdf --out <file> <images>\n".data(using: .utf8)!)
    exit(2)
}

RunLoop.main.run()
