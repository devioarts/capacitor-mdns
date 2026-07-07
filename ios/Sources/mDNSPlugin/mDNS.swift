import Foundation
import Darwin
#if canImport(Network)
import Network
#endif

/// iOS mDNS manager.
/// - Publishes via `NetService`.
/// - Discovers via `NWBrowser` (preferred) or `NetServiceBrowser` as a fallback.
/// - Resolves each candidate with `NetService` to obtain `port`, `hosts`, and optional TXT.
/// - Produces a normalized array of dictionaries consumable by the Capacitor bridge.
public class MDNS: NSObject {
    private static let publishTimeoutMs = 5000

    // MARK: - Advertising

    private var publisher: NetService?
    private var publishCompletion: ((Result<String, Error>) -> Void)?
    private var publishTimeout: DispatchWorkItem?
    private var publishSession: UInt64 = 0

    // MARK: - Discovery state

    private var nsBrowser: NetServiceBrowser?
    #if canImport(Network)
    private var nwBrowser: Any? // keep as `Any` to allow building against older SDKs
    #endif

    /// Map the resolving `NetService` → service box (accumulates details while resolving).
    private var resolveMap: [NetService: ServiceBox] = [:]
    /// Discovered items (kept for dedup / output).
    private var discovered: [ServiceBox] = []

    /// Optional instance-name filter (exact or prefix, both normalized).
    private var targetName: String?

    /// Completion invoked once with either success(array) or failure(error).
    private var discoverCompletion: ((Result<[[String: Any]], Error>) -> Void)?
    private var discoveryError: Error?
    private var discoverySession: UInt64 = 0

    /// Timers: hard timeout and short settle debounce.
    private var hardTimeout: DispatchWorkItem?
    private var settleDebounce: DispatchWorkItem?

    // MARK: - Public API (thread-safe)

    /// Start advertising one Bonjour/mDNS service.
    /// - Parameters:
    ///   - type: Full service type with trailing dot, e.g. `_http._tcp.`
    ///   - name: Instance name (the OS may uniquify it by appending `" (n)"`).
    ///   - port: TCP port (> 0).
    ///   - txt: Optional TXT dictionary (string → string).
    ///   - completion: Called with the final (possibly uniquified) `name`, or an error.
    public func broadcast(
        type: String,
        name: String,
        port: Int,
        txt: [String: String]?,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        guard (1...65535).contains(port) else {
            completion(.failure(Self.error("Missing/invalid port")))
            return
        }

        runOnMain { [weak self] in
            guard let self = self else {
                completion(.failure(Self.error("mDNS manager was released before publishing could start")))
                return
            }

            self.publishSession &+= 1
            let session = self.publishSession
            self.stopPublisherIfNeeded(reason: "Replaced by a new broadcast request")
            self.publishCompletion = completion

            let svc = NetService(domain: "local.", type: type, name: name, port: Int32(port))
            svc.includesPeerToPeer = true

            if let txt = txt {
                let kv: [String: Data] = txt.reduce(into: [:]) { acc, e in
                    acc[e.key] = e.value.data(using: .utf8) ?? Data()
                }
                svc.setTXTRecord(NetService.data(fromTXTRecord: kv))
            }

            svc.delegate = self
            self.publisher = svc
            self.schedulePublishTimeout(session: session)
            // Use default publish options; connection listening not required here.
            svc.publish()
        }
    }

    /// Stop the currently advertised service (no-op safe).
    /// Exposed as `throws` by the bridge, but this implementation does not throw.
    public func stopBroadcast() throws {
        runOnMain { [weak self] in
            self?.stopPublisherIfNeeded(reason: "Publish stopped before completion")
        }
    }

    /// Discover services of a given type.
    /// - Parameters:
    ///   - type: Full service type with trailing dot, e.g. `_http._tcp.`
    ///   - name: Optional instance-name filter (exact or prefix; both normalized).
    ///   - timeoutMs: Hard timeout (milliseconds). Discovery always completes by this time.
    ///   - useNW: Prefer `NWBrowser` when available (default `true`), fallback to `NetServiceBrowser` otherwise.
    ///   - completion: Success with normalized service dictionaries, or failure with error.
    public func discover(
        type: String,
        name: String?,
        timeoutMs: Int,
        useNW: Bool = true,
        completion: @escaping (Result<[[String: Any]], Error>) -> Void
    ) {
        runOnMain { [weak self] in
            guard let self = self else {
                completion(.failure(Self.error("mDNS manager was released before discovery could start")))
                return
            }

            if self.discoverCompletion != nil {
                self.finishDiscovery(error: Self.error("Discovery replaced by a new request"))
            }

            self.discoverySession &+= 1
            let session = self.discoverySession
            // Reset session state.
            self.cancelTimers()
            self.stopBrowsers()
            self.resolveMap.removeAll()
            self.discovered.removeAll()
            self.targetName = name
            self.discoveryError = nil
            self.discoverCompletion = completion

            // Schedule hard timeout (always resolves/finishes).
            let ht = DispatchWorkItem { [weak self] in self?.finishDiscovery(session: session) }
            self.hardTimeout = ht
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(max(0, timeoutMs)), execute: ht)

            // Start browsing: NWBrowser preferred when available and requested.
            #if canImport(Network)
            if useNW, #available(iOS 12.0, *) {
                self.startNWBrowse(typeWithDot: type, session: session)
                return
            }
            #endif
            // Fallback: NetServiceBrowser
            let b = NetServiceBrowser()
            b.includesPeerToPeer = true
            b.delegate = self
            self.nsBrowser = b
            // Empty domain discovers in default domains (typically "local.").
            b.searchForServices(ofType: type, inDomain: "")
        }
    }

    // MARK: - Internal: NWBrowser discovery

    #if canImport(Network)
    @available(iOS 12.0, *)
    private func startNWBrowse(typeWithDot: String, session: UInt64) {
        // NWBrowser expects type without trailing dot.
        let typeNoDot = typeWithDot.hasSuffix(".") ? String(typeWithDot.dropLast()) : typeWithDot

        let params = NWParameters()
        params.includePeerToPeer = true

        let browser = NWBrowser(for: .bonjour(type: typeNoDot, domain: nil), using: params)
        self.nwBrowser = browser

        browser.stateUpdateHandler = { state in
            switch state {
            case .failed(let err):
                DispatchQueue.main.async { [weak self] in
                    self?.finishDiscovery(session: session, error: err)
                }
            default:
                break
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self = self else { return }
            guard session == self.discoverySession, self.discoverCompletion != nil else { return }
            for r in results {
                guard case let NWEndpoint.service(name: n, type: t, domain: d, interface: _) = r.endpoint else { continue }
                if !self.matchesTarget(n) { continue }

                // Use NetService for resolve (port/hosts/TXT) to keep output parity with fallback.
                let key = self.keyFor(name: n, type: t, domain: d)
                if self.discovered.contains(where: { $0.identityKey == key }) { continue }

                let resolver = NetService(domain: d.isEmpty ? "local." : d,
                                          type: t.hasSuffix(".") ? t : t + ".",
                                          name: n)
                resolver.includesPeerToPeer = true
                resolver.delegate = self

                let box = ServiceBox(name: n, type: resolver.type, domain: resolver.domain)
                self.discovered.append(box)
                self.resolveMap[resolver] = box
                resolver.resolve(withTimeout: 5.0)

                // Reschedule short settle window on each new find.
                self.scheduleSettleDebounce(session: session)
            }
        }

        browser.start(queue: .main)
    }
    #endif

    // MARK: - Internal: finalize & helpers

    /// Build the final output and complete the discovery promise.
    private func finishDiscovery(session: UInt64? = nil, error: Error? = nil) {
        if let session = session, session != discoverySession { return }

        cancelTimers()
        stopBrowsers()

        // Keep only resolved entries, and deduplicate by (name:port:host0).
        var seen = Set<String>()
        var out: [[String: Any]] = []

        for box in discovered where box.resolved {
            let key = "\(box.name):\(box.port):\(box.hosts.first ?? "")"
            if seen.contains(key) { continue }
            seen.insert(key)

            var entry: [String: Any] = [
                "name": box.name,
                "type": box.type,
                "domain": box.domain,
                "port": box.port
            ]
            if !box.hosts.isEmpty { entry["hosts"] = box.hosts }
            if !box.txt.isEmpty { entry["txt"] = box.txt }
            out.append(entry)
        }

        // Clear state before invoking the callback.
        resolveMap.removeAll()
        discovered.removeAll()
        targetName = nil
        let finalError = error ?? discoveryError
        discoveryError = nil

        let cb = discoverCompletion
        discoverCompletion = nil
        if let finalError = finalError {
            cb?(.failure(finalError))
        } else {
            cb?(.success(out))
        }
    }

    /// Cancel timers (hard timeout and settle debounce).
    private func cancelTimers() {
        hardTimeout?.cancel(); hardTimeout = nil
        settleDebounce?.cancel(); settleDebounce = nil
    }

    /// Schedule a short debounce to finish discovery when the system becomes idle.
    private func scheduleSettleDebounce(session: UInt64? = nil, _ ms: Int = 350) {
        settleDebounce?.cancel()
        let session = session ?? discoverySession
        let wi = DispatchWorkItem { [weak self] in self?.finishDiscovery(session: session) }
        settleDebounce = wi
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms), execute: wi)
    }

    /// Stop any active browsers.
    private func stopBrowsers() {
        #if canImport(Network)
        if #available(iOS 12.0, *) {
            (nwBrowser as? NWBrowser)?.cancel()
            nwBrowser = nil
        }
        #endif
        // Stop all in-flight resolvers as well (best-effort).
        for (svc, _) in resolveMap {
            svc.stop()
            svc.delegate = nil
        }
        resolveMap.removeAll()
        nsBrowser?.stop()
        nsBrowser?.delegate = nil
        nsBrowser = nil
    }

    /// Stop the current publisher, if any.
    private func stopPublisherIfNeeded(reason: String) {
        publishTimeout?.cancel()
        publishTimeout = nil
        publisher?.stop()
        publisher?.delegate = nil
        publisher = nil
        publishCompletion?(.failure(Self.error(reason)))
        publishCompletion = nil
    }

    /// Enforce that NetService publish cannot leave a JS promise pending forever.
    private func schedulePublishTimeout(session: UInt64) {
        publishTimeout?.cancel()
        let wi = DispatchWorkItem { [weak self] in
            guard let self = self, session == self.publishSession, self.publishCompletion != nil else { return }
            self.stopPublisherIfNeeded(reason: "Timed out waiting for service publish after \(Self.publishTimeoutMs)ms")
        }
        publishTimeout = wi
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Self.publishTimeoutMs), execute: wi)
    }

    /// Normalize a service name by removing the system-appended `" (n)"` suffix.
    private func normalize(_ s: String) -> String {
        return s.replacingOccurrences(of: #" \(\d+\)$"#, with: "", options: .regularExpression)
    }

    /// Does `candidate` match `targetName` exactly or by prefix (both normalized)? If no target, accept all.
    private func matchesTarget(_ candidate: String) -> Bool {
        guard let t = targetName, !t.isEmpty else { return true }
        let c = normalize(candidate), tt = normalize(t)
        return (c == tt) || c.hasPrefix(tt)
    }

    /// Build a stable identity key for deduplication.
    private func keyFor(name: String, type: String, domain: String) -> String {
        return "\(name)|\(type)|\(domain)"
    }

    /// Ensure execution on main queue (NSNetServices expect main run loop).
    private func runOnMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
    }

    private static func error(_ message: String) -> NSError {
        return NSError(domain: "mDNS", code: -1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

// MARK: - NetServiceDelegate (publish + resolve)

extension MDNS: NetServiceDelegate {

    // Publish callbacks
    public func netServiceDidPublish(_ sender: NetService) {
        guard sender === publisher else { return }
        publishTimeout?.cancel()
        publishTimeout = nil
        let cb = publishCompletion
        publishCompletion = nil
        cb?(.success(sender.name))
    }

    public func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
        guard sender === publisher else { return }
        publishTimeout?.cancel()
        publishTimeout = nil
        publisher = nil
        let cb = publishCompletion
        publishCompletion = nil
        let code = (errorDict[NetService.errorCode] as NSNumber?)?.intValue ?? -1
        let err = NSError(
            domain: "mDNS.publish",
            code: code,
            userInfo: [NSLocalizedDescriptionKey: "Failed to publish service", "info": errorDict]
        )
        cb?(.failure(err))
    }

    // Resolve callbacks
    public func netServiceDidResolveAddress(_ sender: NetService) {
        guard let box = resolveMap[sender] else { return }
        box.port = Int(sender.port)
        box.hosts = parseHosts(sender.addresses)
        if let txtData = sender.txtRecordData() {
            let dict = NetService.dictionary(fromTXTRecord: txtData)
            box.txt = dict.reduce(into: [:]) { acc, e in
                acc[e.key] = String(data: e.value, encoding: .utf8) ?? ""
            }
        }
        box.resolved = true

        // Early finish if a specific target is requested and this service matches it.
        if let t = targetName, !t.isEmpty, matchesTarget(sender.name) {
            finishDiscovery(session: discoverySession)
        } else {
            // Otherwise, allow a brief settle window to collect late peers.
            scheduleSettleDebounce(session: discoverySession)
        }
    }

    public func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        // Drop the unresolved service and try to continue with others.
        resolveMap.removeValue(forKey: sender)
        scheduleSettleDebounce(session: discoverySession)
    }
}

// MARK: - NetServiceBrowserDelegate (fallback browsing)

extension MDNS: NetServiceBrowserDelegate {

    public func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        // Early filter by instance name.
        guard matchesTarget(service.name) else { return }

        let key = keyFor(name: service.name, type: service.type, domain: service.domain)
        if discovered.contains(where: { $0.identityKey == key }) { return }

        // Create a dedicated resolver (do not reuse `service` directly).
        let resolver = NetService(domain: service.domain, type: service.type, name: service.name)
        resolver.includesPeerToPeer = true
        resolver.delegate = self

        // Track box + resolver pair.
        let box = ServiceBox(name: service.name, type: service.type, domain: service.domain)
        resolveMap[resolver] = box
        discovered.append(box)

        resolver.resolve(withTimeout: 5.0)

        // If this wave ends soon, schedule settle debounce; else wait for more.
        if !moreComing { scheduleSettleDebounce(session: discoverySession) }
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        // Not critical for snapshot output; ignore.
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        let code = (errorDict[NetService.errorCode] as NSNumber?)?.intValue ?? -1
        let err = NSError(
            domain: "mDNS.discovery",
            code: code,
            userInfo: [NSLocalizedDescriptionKey: "Failed to search for services", "info": errorDict]
        )
        finishDiscovery(session: discoverySession, error: err)
    }
}

// MARK: - Model

/// Mutable container while resolving a service.
private final class ServiceBox: Hashable {
    let name: String
    let type: String
    let domain: String

    var port: Int = 0
    var hosts: [String] = []
    var txt: [String: String] = [:]
    var resolved: Bool = false

    init(name: String, type: String, domain: String) {
        self.name = name
        self.type = type
        self.domain = domain
    }

    var identityKey: String { "\(name)|\(type)|\(domain)" }

    static func == (lhs: ServiceBox, rhs: ServiceBox) -> Bool {
        lhs.identityKey == rhs.identityKey
    }
    func hash(into hasher: inout Hasher) { hasher.combine(identityKey) }
}

// MARK: - Address utilities

/// Convert `NetService.addresses` to numeric IPv4/IPv6 strings.
private func parseHosts(_ addrs: [Data]?) -> [String] {
    guard let addrs = addrs, !addrs.isEmpty else { return [] }
    var out: [String] = []
    out.reserveCapacity(addrs.count)

    for data in addrs {
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            let sa = base.assumingMemoryBound(to: sockaddr.self)
            let family = Int32(sa.pointee.sa_family)

            if family == AF_INET {
                var addr = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
                var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                if inet_ntop(AF_INET, &addr, &buf, socklen_t(INET_ADDRSTRLEN)) != nil {
                    out.append(String(cString: buf))
                }
            } else if family == AF_INET6 {
                var addr6 = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee.sin6_addr }
                var buf6 = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
                if inet_ntop(AF_INET6, &addr6, &buf6, socklen_t(INET6_ADDRSTRLEN)) != nil {
                    out.append(String(cString: buf6))
                }
            }
        }
    }
    return out
}
