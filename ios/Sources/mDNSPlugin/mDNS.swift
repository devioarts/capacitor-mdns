import Foundation
import Network
#if DEBUG
import os
#endif

/// MDNS encapsulates Bonjour/mDNS advertise and discovery flows for iOS.
/// Public APIs are thread-safe: they hop to the main thread internally because
/// NetService/NetServiceBrowser/NWBrowser must be used from a runloop thread (usually main).
final class MDNS: NSObject {

    // MARK: - Debug logging (silent in Release)

    #if DEBUG
    @available(iOS 14.0, *)
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "MDNS",
        category: "mDNS"
    )
    #endif

    /// Debug log helper: evaluates the message before passing to Logger to avoid
    /// escaping/non-escaping autoclosure issues.
    @inline(__always)
    private func dlog(_ message: @autoclosure () -> String) {
        #if DEBUG
        let s = message()
        if #available(iOS 14.0, *) {
            MDNS.logger.debug("\(s, privacy: .public)")
        } else {
            print(s)
        }
        #endif
    }

    // MARK: - Threading helper

    /// Ensure work runs on the main thread.
    @inline(__always)
    private func runOnMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread { block() } else { DispatchQueue.main.async { block() } }
    }

    // MARK: - Internal state (advertise)

    private var service: NetService?
    /// Completion for publish; delivers final registered name (may be uniquified).
    private var publishCompletion: ((Result<String, Error>) -> Void)?

    // MARK: - Internal state (discover)

    private var browser: NetServiceBrowser?
    private var nwBrowser: NWBrowser?
    private var found: [String: NetService] = [:]   // name -> NetService to resolve
    private var resolveRemaining = 0                // number of in-flight resolves
    private var discoveryCompletion: (([[String: Any]]) -> Void)?
    private var targetId: String?

    // Debounce/timeout machinery
    private var hardTimeoutWorkItem: DispatchWorkItem?
    private var settleWorkItem: DispatchWorkItem?

    // MARK: - Timer helpers

    /// Cancel any scheduled timers.
    private func cancelTimers() {
        hardTimeoutWorkItem?.cancel(); hardTimeoutWorkItem = nil
        settleWorkItem?.cancel(); settleWorkItem = nil
    }

    /// Centralized finalize: stop browsers, cancel timers, deliver results (always on main).
    private func finish(filterName: String?) {
        guard let done = discoveryCompletion else { return }
        discoveryCompletion = nil
        targetId = nil
        cancelTimers()
        nwBrowser?.cancel(); nwBrowser = nil
        browser?.stop(); browser = nil
        let list = collectResults(filterName: filterName)
        done(list)
    }

    /// Schedule a hard timeout which always finishes discovery with whatever has been collected.
    private func scheduleHardTimeout(_ ms: Int, filterName: String?) {
        let wi = DispatchWorkItem { [weak self] in self?.finish(filterName: filterName) }
        hardTimeoutWorkItem = wi
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms), execute: wi)
    }

    /// Debounce/settle: finish only if nothing else is resolving and no new results arrived recently.
    private func scheduleSettle(_ ms: Int = 400, filterName: String?) {
        settleWorkItem?.cancel()
        let wi = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            if self.resolveRemaining == 0 {
                self.finish(filterName: filterName)
            }
            // If still resolving, do nothing; hard timeout will eventually fire.
        }
        settleWorkItem = wi
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms), execute: wi)
    }

    // MARK: - Public API (thread-safe)

    /// Publish a Bonjour service.
    /// - Parameters:
    ///   - type: e.g. "_http._tcp." (must end with ".")
    ///   - name: Instance name (system may uniquify by appending " (n)")
    ///   - domain: Usually "local."
    ///   - port: TCP port (> 0)
    ///   - txt: Optional TXT map (UTF-8)
    ///   - onPublished: Optional callback with the final (possibly uniquified) instance name or an error.
    func broadcast(
        type: String,
        name: String,
        domain: String,
        port: Int,
        txt: [String: String]?,
        onPublished: ((Result<String, Error>) -> Void)? = nil
    ) {
        runOnMain { [weak self] in
            guard let self = self else { return }
            self.stopBroadcast()                 // keep a single active service
            self.publishCompletion = onPublished // store completion for delegate callback

            let svc = NetService(domain: domain, type: type, name: name, port: Int32(port))
            svc.includesPeerToPeer = true
            if let txt = txt {
                let dict = txt.reduce(into: [String: Data]()) { $0[$1.key] = $1.value.data(using: .utf8) }
                svc.setTXTRecord(NetService.data(fromTXTRecord: dict))
            }

            svc.delegate = self
            self.service = svc
            svc.publish(options: .listenForConnections)
        }
    }

    /// Stop the currently advertised service, if any.
    /// If publish hasn't completed yet, consider it cancelled.
    func stopBroadcast() {
        runOnMain { [weak self] in
            guard let self = self else { return }
            self.service?.stop()
            self.service = nil
            if let cb = self.publishCompletion {
                self.publishCompletion = nil
                let err = NSError(
                    domain: "MDNS",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Publish cancelled"]
                )
                cb(.failure(err))
            }
        }
    }

    /// Discover services of a given type.
    ///
    /// The completion is invoked on the main thread with a normalized array:
    /// `[["name": String, "type": String, "domain": String, "port": Int, "hosts": [String], "txt": [String:String]?], ...]`
    ///
    /// Strategy:
    /// - Start browse (NWBrowser preferred).
    /// - Resolve each candidate via NetService for port + addresses.
    /// - Use a "settle" debounce to allow late results; finish when nothing else is resolving.
    /// - Always enforce a hard timeout to avoid hanging.
    func discover(
        type: String,
        id: String?,
        timeoutMs: Int,
        useNW: Bool,
        completion: @escaping ([[String: Any]]) -> Void
    ) {
        runOnMain { [weak self] in
            guard let self = self else { return }

            // Reset session
            self.cancelTimers()
            self.browser?.stop(); self.browser = nil
            self.nwBrowser?.cancel(); self.nwBrowser = nil
            self.found.removeAll()
            self.resolveRemaining = 0
            self.targetId = id

            // Wrap completion to guarantee main-thread delivery and cleanup.
            self.discoveryCompletion = { [weak self] services in
                guard let self = self else { return }
                self.cancelTimers()
                self.nwBrowser?.cancel(); self.nwBrowser = nil
                self.browser?.stop(); self.browser = nil
                completion(services)
            }

            // Start browsing
            if useNW {
                self.startNWBrowse(typeWithDot: type, targetId: id, timeoutMs: timeoutMs)
            } else {
                let b = NetServiceBrowser()
                b.includesPeerToPeer = true
                b.delegate = self
                self.browser = b
                // Empty domain ("") discovers in default domains (typically "local.")
                b.searchForServices(ofType: type, inDomain: "")
            }

            // Hard timeout: always finish after timeoutMs with whatever we have.
            self.scheduleHardTimeout(timeoutMs, filterName: id)
        }
    }

    // MARK: - NWBrowser path

    /// Start discovery using NWBrowser (Network framework).
    /// Uses includePeerToPeer for better AWDL/BT discovery behavior.
    private func startNWBrowse(
        typeWithDot: String,
        targetId: String?,
        timeoutMs: Int
    ) {
        // NWBrowser expects type without the trailing dot.
        let typeNoDot = typeWithDot.hasSuffix(".") ? String(typeWithDot.dropLast()) : typeWithDot

        // Use generic NWParameters and explicitly enable P2P.
        let params = NWParameters()
        params.includePeerToPeer = true

        let b = NWBrowser(for: .bonjour(type: typeNoDot, domain: nil), using: params)
        nwBrowser = b

        b.stateUpdateHandler = { [weak self] state in
            self?.dlog("[mDNS][NW] state: \(state)")
        }

        b.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self = self else { return }
            for r in results {
                guard case let .service(name: name, type: type, domain: domain, interface: _) = r.endpoint else { continue }

                // Optional filter by instance name (normalized exact OR prefix match).
                if !self.matchesTarget(candidate: name, target: targetId) { continue }

                // Use NetService only to resolve host addresses and port.
                if self.found[name] == nil {
                    let svc = NetService(
                        domain: domain.isEmpty ? "local." : domain,
                        type: type.hasSuffix(".") ? type : type + ".",
                        name: name
                    )
                    svc.includesPeerToPeer = true
                    svc.delegate = self
                    self.found[name] = svc
                    self.resolveRemaining += 1
                    svc.resolve(withTimeout: 5.0)
                    self.dlog("[mDNS][NW] found: \(name) \(type) \(domain)")

                    // Every new discovery reschedules a short settle window.
                    self.scheduleSettle(400, filterName: targetId)
                }
            }
        }

        b.start(queue: .main)
    }

    // MARK: - Helpers

    /// Build a normalized JSON-like array of services.
    /// If `filterName` is set, only services with equal or prefix-matching normalized names are returned.
    private func collectResults(filterName: String?) -> [[String: Any]] {
        return found.values.compactMap { svc in
            if !matchesTarget(candidate: svc.name, target: filterName) { return nil }

            var obj: [String: Any] = [
                "name": svc.name,
                "type": svc.type,
                "domain": svc.domain,
                "port": svc.port,
            ]

            // TXT
            if let data = svc.txtRecordData() {
                let dict = NetService.dictionary(fromTXTRecord: data)
                obj["txt"] = dict.reduce(into: [String: String]()) { acc, kv in
                    acc[kv.key] = String(data: kv.value, encoding: .utf8) ?? ""
                }
            }

            // Hosts (numeric v4/v6)
            if let addresses = svc.addresses, !addresses.isEmpty {
                let hosts = addresses.compactMap { addrData -> String? in
                    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    return addrData.withUnsafeBytes {
                        guard let sa = $0.baseAddress?.assumingMemoryBound(to: sockaddr.self) else { return nil }
                        let r = getnameinfo(
                            sa,
                            socklen_t(sa.pointee.sa_len),
                            &host,
                            socklen_t(host.count),
                            nil,
                            0,
                            NI_NUMERICHOST
                        )
                        return r == 0 ? String(cString: host) : nil
                    }
                }
                if !hosts.isEmpty { obj["hosts"] = hosts }
            }
            return obj
        }
    }

    /// Normalize a service name by removing the system-appended " (n)" suffix.
    private func normalize(_ s: String) -> String {
        return s.replacingOccurrences(of: #" \(\d+\)$"#, with: "", options: .regularExpression)
    }

    /// Return true if `candidate` matches `target` by exact OR prefix match (both normalized).
    /// When `target` is nil, it accepts all candidates.
    private func matchesTarget(candidate: String, target: String?) -> Bool {
        guard let t = target else { return true }
        let c1 = normalize(candidate)
        let c2 = normalize(t)
        return (c1 == c2) || c1.hasPrefix(c2)
    }
}

// MARK: - NetServiceBrowserDelegate

extension MDNS: NetServiceBrowserDelegate {
    public func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        dlog("[mDNS] found: \(service.name) \(service.type) \(service.domain)")
        found[service.name] = service
        service.delegate = self
        resolveRemaining += 1
        service.resolve(withTimeout: 5.0)

        // When more are coming, do not finish yet; reschedule settle when wave slows down.
        if !moreComing { scheduleSettle(350, filterName: targetId) }
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        found.removeValue(forKey: service.name)
    }

    public func netServiceBrowserWillSearch(_ browser: NetServiceBrowser) {
        dlog("[mDNS] willSearch")
    }

    public func netServiceBrowserDidStopSearch(_ browser: NetServiceBrowser) {
        dlog("[mDNS] didStopSearch")
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        dlog("[mDNS] didNotSearch \(errorDict)")
        // Safely end with whatever we have so far.
        finish(filterName: targetId)
    }
}

// MARK: - NetServiceDelegate

extension MDNS: NetServiceDelegate {
    /// Called when the service has been successfully published.
    /// The service name may already be uniquified (e.g., "My App (2)").
    public func netServiceDidPublish(_ sender: NetService) {
        if let cb = publishCompletion {
            publishCompletion = nil
            cb(.success(sender.name))
        }
    }

    public func netServiceDidResolveAddress(_ sender: NetService) {
        dlog("[mDNS] resolved: \(sender.name) \(sender.port)")
        resolveRemaining = max(0, resolveRemaining - 1)

        // Early-exit: if a specific target was requested and this is a match, finish now.
        if matchesTarget(candidate: sender.name, target: targetId), discoveryCompletion != nil {
            // Use targetId as filter so prefix matches are included as well.
            finish(filterName: targetId)
            return
        }

        // Debounce: if nothing else is resolving, finish soon; otherwise let hard timeout fire.
        scheduleSettle(300, filterName: targetId)
    }

    public func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        dlog("[mDNS] resolveFailed \(sender.name) \(errorDict)")
        resolveRemaining = max(0, resolveRemaining - 1)

        // Early-exit if the requested target failed to resolve—still deliver what we have so far.
        if matchesTarget(candidate: sender.name, target: targetId), discoveryCompletion != nil {
            finish(filterName: targetId)
            return
        }

        scheduleSettle(300, filterName: targetId)
    }

    /// Called when the service failed to publish. We translate the error dictionary into NSError.
    public func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
        if let cb = publishCompletion {
            publishCompletion = nil
            let code = (errorDict[NetService.errorCode] as NSNumber?)?.intValue ?? -1
            let err = NSError(
                domain: "NSNetServicesErrorDomain",
                code: code,
                userInfo: [
                    NSLocalizedDescriptionKey: "Failed to publish mDNS service",
                    "info": errorDict
                ]
            )
            cb(.failure(err))
        }
    }
}