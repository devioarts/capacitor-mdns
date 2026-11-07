import Capacitor
import Foundation
import CoreFoundation

/**
 * Capacitor bridge for the iOS mDNS plugin.
 *
 * Responsibilities:
 * - Exposes the native MDNS manager to JavaScript.
 * - Validates and normalizes params (ensures trailing dot in type, sensible defaults).
 * - Never rejects on runtime errors; always resolves with { error, errorMessage }.
 *
 * Methods:
 * - startBroadcast({ type?, name?, port, txt? })
 * - stopBroadcast()
 * - discover({ type?, name?, timeout? })
 */
@objc(mDNSPlugin)
public class mDNSPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "mDNSPlugin"
    public let jsName = "mDNS"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPluginPlatform", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBroadcast", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBroadcast", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "watchServices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopWatching", returnType: CAPPluginReturnPromise)
    ]

    private let mdns = MDNS()

    override public func load() {
        super.load()
        mdns.watchDelegate = self
    }

    // MARK: - Helpers

    private func jnull(_ v: String?) -> Any {
        return v ?? NSNull()
    }

    private func stringOption(_ call: CAPPluginCall, _ key: String) throws -> String? {
        guard let raw = call.options[key], !(raw is NSNull) else { return nil }
        guard let value = raw as? String else { throw inputError("Invalid \(key)") }
        return value
    }
    private func inputError(_ message: String) -> NSError {
        NSError(domain: "mDNS", code: -1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    private func numberOption(_ call: CAPPluginCall, _ key: String, fallback: Double) throws -> Double {
        guard let raw = call.options[key], !(raw is NSNull) else { return fallback }
        guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { throw inputError("Invalid \(key)") }
        return value.doubleValue
    }
    // MARK: - API

    /// getPluginPlatform()
    @objc public func getPluginPlatform(_ call: CAPPluginCall) {
        call.resolve([
            "platform": "ios"
        ])
    }

    /// startBroadcast({ type?, name?, port, txt? })
    @objc public func startBroadcast(_ call: CAPPluginCall) {
        let type: String, name: String, port: Int, txt: [String: String]?
        do {
            type = try MDNS.validatedType(stringOption(call, "type") ?? "")
            name = try MDNS.validatedName(stringOption(call, "name") ?? "")
            let number = try numberOption(call, "port", fallback: 0)
            guard (1...65535).contains(number), number.rounded(.towardZero) == number else { throw inputError("Missing/invalid port") }
            port = Int(number)
            let raw = call.options["txt"]
            if raw == nil || raw is NSNull { txt = nil } else {
                guard let values = raw as? [String: String] else { throw inputError("TXT must be an object of strings") }
                txt = values
            }
            try MDNS.validateTXT(txt)
        } catch {
            call.resolve(["publishing": mdns.isPublishing, "name": "", "error": true, "errorMessage": error.localizedDescription])
            return
        }
        mdns.broadcast(type: type, name: name, port: port, txt: txt) { result in
            switch result {
            case .success(let finalName):
                call.resolve([
                    "publishing": true,
                    "name": finalName,
                    "error": false,
                    "errorMessage": NSNull()
                ])
            case .failure(let err):
                call.resolve([
                    "publishing": false,
                    "name": "",
                    "error": true,
                    "errorMessage": self.jnull(err.localizedDescription)
                ])
            }
        }
    }

    /// stopBroadcast()
    @objc public func stopBroadcast(_ call: CAPPluginCall) {
        do {
            try mdns.stopBroadcast()
            call.resolve([
                "publishing": false,
                "error": false,
                "errorMessage": NSNull()
            ])
        } catch {
            call.resolve([
                "publishing": false,
                "error": true,
                "errorMessage": jnull(error.localizedDescription)
            ])
        }
    }

    /// discover({ type?, name?, timeout? })
    @objc public func discover(_ call: CAPPluginCall) {
        let type: String, targetName: String?, timeout: Int
        do {
            type = try MDNS.validatedType(stringOption(call, "type") ?? "")
            let name = try MDNS.validatedName(stringOption(call, "name") ?? "")
            targetName = name.isEmpty ? nil : name
            timeout = Int(min(2_147_483_647, max(0, try numberOption(call, "timeout", fallback: 3000))))
        } catch {
            call.resolve(["error": true, "errorMessage": error.localizedDescription, "servicesFound": 0, "services": []])
            return
        }
        let useNW = call.getBool("useNW") ?? true
        mdns.discover(type: type, name: targetName, timeoutMs: timeout, useNW: useNW) { result in
            switch result {
            case .success(let services):
                call.resolve([
                    "error": false,
                    "errorMessage": NSNull(),
                    "servicesFound": services.count,
                    "services": services
                ])
            case .failure(let err):
                call.resolve([
                    "error": true,
                    "errorMessage": self.jnull(err.localizedDescription),
                    "servicesFound": 0,
                    "services": []
                ])
            }
        }
    }

    @objc public func watchServices(_ call: CAPPluginCall) {
        guard let types = call.getArray("types", String.self), !types.isEmpty else {
            call.resolve(["error": true, "errorMessage": "Expected a nonempty array of service types", "watchersStarted": 0])
            return
        }
        mdns.watchServices(types: types) { result in
            switch result {
            case .success(let count): call.resolve(["error": false, "errorMessage": NSNull(), "watchersStarted": count])
            case .failure(let error): call.resolve(["error": true, "errorMessage": error.localizedDescription, "watchersStarted": 0])
            }
        }
    }

    @objc public func stopWatching(_ call: CAPPluginCall) {
        mdns.stopWatching {
            call.resolve(["watching": false, "error": false, "errorMessage": NSNull()])
        }
    }
}

extension mDNSPlugin: MDNSWatchDelegate {
    public func mdns(_ mdns: MDNS, didFindService service: [String: Any]) {
        notifyListeners("serviceFound", data: ["service": service])
    }
    public func mdns(_ mdns: MDNS, didLoseService service: [String: Any]) {
        notifyListeners("serviceLost", data: ["service": service])
    }
    public func mdns(_ mdns: MDNS, watchError type: String, message: String, watching: Bool) {
        notifyListeners("watchError", data: ["type": type, "errorMessage": message, "watching": watching])
    }
}
