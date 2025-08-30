import Capacitor
import Foundation

/**
 * Capacitor bridge for the iOS mDNS plugin.
 *
 * Responsibilities:
 * - Keep a single MDNS manager instance per plugin.
 * - Map JS calls to native methods and normalize responses.
 * - Avoid long-running work here; heavy lifting lives in `MDNS`.
 */
@objc(mDNSPlugin)
public class mDNSPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "mDNSPlugin"
    public let jsName = "mDNS"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startBroadcast", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBroadcast", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discover", returnType: CAPPluginReturnPromise),
    ]

    /// Single manager instance used by this plugin.
    private let mdns = MDNS()

    /**
     * Start advertising a Bonjour/mDNS service.
     *
     * Expected options:
     *   - type?: string = "_http._tcp."  (trailing dot is enforced)
     *   - id?:   string = "CapacitorMDNS" (non-empty preferred)
     *   - domain?: string = "local."
     *   - port: number  (> 0)
     *   - txt?: Record<string,string>
     *
     * Resolves with: { publishing: true, name: string }
     * Note: The promise resolves after the system confirms publish (NetService.didPublish),
     * so `name` is the final instance name (may include " (n)").
     */
    @objc public func startBroadcast(_ call: CAPPluginCall) {
        var type = call.getString("type") ?? "_http._tcp."
        if type.last != "." { type += "." }

        // Prefer a non-empty 'id'; otherwise fall back to a constant.
        let rawId = call.getString("id")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name  = (rawId?.isEmpty == false ? rawId! : "CapacitorMDNS")

        let port = call.getInt("port") ?? 0
        guard port > 0 else { call.reject("Missing/invalid port"); return }

        let domain = call.getString("domain") ?? "local."
        let txt    = call.getObject("txt") as? [String: String]

        mdns.broadcast(type: type, name: name, domain: domain, port: port, txt: txt) { result in
            switch result {
            case .success(let finalName):
                call.resolve(["publishing": true, "name": finalName])
            case .failure(let err):
                call.reject(err.localizedDescription)
            }
        }
    }

    /**
     * Stop advertising the currently registered service (no-op if none).
     * Resolves with: { publishing: false }
     */
    @objc public func stopBroadcast(_ call: CAPPluginCall) {
        mdns.stopBroadcast()
        call.resolve(["publishing": false])
    }

    /**
     * Discover services and return a normalized list.
     *
     * Expected options:
     *   - type?: string = "_http._tcp."
     *   - id?:   string (optional instance-name filter; exact OR prefix match)
     *   - timeoutMs?: number = 3000
     *   - useNW?: boolean = true  (use NWBrowser when available)
     *
     * Resolves with: { services: Array<{ name,type,domain,port,hosts?,txt? }> }
     */
    @objc public func discover(_ call: CAPPluginCall) {
        var type = call.getString("type") ?? "_http._tcp."
        if type.last != "." { type += "." }

        let targetId = call.getString("id")
        let timeoutMs = call.getInt("timeoutMs") ?? 3000
        let useNW = call.getBool("useNW") ?? true

        mdns.discover(type: type, id: targetId, timeoutMs: timeoutMs, useNW: useNW) { services in
            call.resolve(["services": services])
        }
    }
}
