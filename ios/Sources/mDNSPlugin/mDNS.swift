import Foundation
import Darwin
import Network

/// iOS mDNS manager.
/// - Publishes via `NetService`.
/// - Discovers via `NWBrowser` (preferred) or `NetServiceBrowser` as a fallback.
/// - Resolves each candidate with `NetService` to obtain `port`, `hosts`, and optional TXT.
/// - Produces a normalized array of dictionaries consumable by the Capacitor bridge.
public class MDNS: NSObject {
    // Tunables and seams. Internal (not private) so unit tests can shorten timers and inject fake services.
    internal var publishTimeoutMs = 5000
    internal var resolveTimeoutSeconds: TimeInterval = 5.0
    internal var makeBrowser: () -> NetServiceBrowser = { NetServiceBrowser() }
    internal var scheduleDiscoveryTimeout: (Int, DispatchWorkItem) -> Void = { delayMs, work in
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(delayMs), execute: work)
    }
    internal var makeService: (_ domain: String, _ type: String, _ name: String, _ port: Int32?) -> NetService =
        MDNS.defaultMakeService

    private static func defaultMakeService(_ domain: String, _ type: String, _ name: String, _ port: Int32?) -> NetService {
        if let port = port {
            return NetService(domain: domain, type: type, name: name, port: port)
        }
        return NetService(domain: domain, type: type, name: name)
    }

    // MARK: - Advertising

    public weak var watchDelegate: MDNSWatchDelegate?
    private var watchSession: WatchSession?

    private var publisher: NetService?
    private var publishCompletion: ((Result<String, Error>) -> Void)?
    private var publishTimeout: DispatchWorkItem?
    private var publishSession: UInt64 = 0

    // MARK: - Discovery state

    private var nsBrowser: NetServiceBrowser?
    private var nwBrowser: NWBrowser?

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

    /// Discovery hard timeout.
    private var hardTimeout: DispatchWorkItem?

    deinit {
        watchSession?.stop()
        publishTimeout?.cancel()
        publisher?.stop()
        publisher?.delegate = nil
        cancelTimers()
        stopBrowsers()
    }

    // MARK: - Public API (thread-safe)

    /// Start advertising one Bonjour/mDNS service.
    /// - Parameters:
    ///   - type: Full service type with trailing dot, e.g. `_http._tcp.`
    ///   - name: Instance name (the OS may uniquify it by appending `" (n)"`).
    ///   - port: TCP port (> 0).
    ///   - txt: Optional TXT dictionary (string → string).
    ///   - completion: Called with the final (possibly uniquified) `name`, or an error.
    public func broadcast(
        type rawType: String,
        name rawName: String,
        port: Int,
        txt: [String: String]?,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        let type: String
        let name: String
        do {
            guard (1...65535).contains(port) else { throw Self.error("Missing/invalid port") }
            type = try Self.validatedType(rawType)
            let normalizedName = try Self.validatedName(rawName)
            name = normalizedName.isEmpty ? "DevIOArtsMDNS" : normalizedName
            try Self.validateTXT(txt)
        } catch { completion(.failure(error)); return }

        runOnMain { [weak self] in
            guard let self = self else {
                completion(.failure(Self.error("mDNS manager was released before publishing could start")))
                return
            }

            self.publishSession &+= 1
            let session = self.publishSession
            self.stopPublisherIfNeeded(reason: "Replaced by a new broadcast request")
            self.publishCompletion = completion

            let svc = self.makeService("local.", type, name, Int32(port))
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
        type rawType: String,
        name rawName: String?,
        timeoutMs: Int,
        useNW: Bool = true,
        completion: @escaping (Result<[[String: Any]], Error>) -> Void
    ) {
        let type: String
        let name: String?
        do {
            type = try Self.validatedType(rawType)
            let trimmed = try Self.validatedName(rawName ?? "")
            name = trimmed.isEmpty ? nil : trimmed
        } catch { completion(.failure(error)); return }
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
            self.scheduleDiscoveryTimeout(max(0, timeoutMs), ht)

            // Start browsing: NWBrowser preferred when available and requested.
            if useNW {
                self.startNWBrowse(typeWithDot: type, session: session)
                return
            }
            // Fallback: NetServiceBrowser
            let b = self.makeBrowser()
            b.includesPeerToPeer = true
            b.delegate = self
            self.nsBrowser = b
            // Empty domain discovers in default domains (typically "local.").
            b.searchForServices(ofType: type, inDomain: "")
        }
    }

    // MARK: - Internal: NWBrowser discovery

    private func startNWBrowse(typeWithDot: String, session: UInt64) {
        // NWBrowser expects type without trailing dot.
        let typeNoDot = typeWithDot.hasSuffix(".") ? String(typeWithDot.dropLast()) : typeWithDot

        let params = NWParameters()
        params.includePeerToPeer = true

        let browser = NWBrowser(for: .bonjour(type: typeNoDot, domain: nil), using: params)
        self.nwBrowser = browser

        browser.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed(let err):
                DispatchQueue.main.async { [weak self] in
                    self?.finishDiscovery(session: session, error: err)
                }
            case .waiting(let err):
                // Denied Local Network permission parks the browser in `.waiting` forever; surface it.
                if Self.isLocalNetworkDenied(err) {
                    DispatchQueue.main.async { [weak self] in
                        self?.finishDiscovery(
                            session: session,
                            error: Self.error("Local network access denied. Enable it in Settings > Privacy > Local Network.")
                        )
                    }
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
                self.handleServiceFound(name: n, type: t, domain: d)
            }
        }

        browser.start(queue: .main)
    }

    // MARK: - Internal: finalize & helpers

    /// Build the final output and complete the discovery promise.
    private func finishDiscovery(session: UInt64? = nil, error: Error? = nil) {
        if let session = session, session != discoverySession { return }

        cancelTimers()
        stopBrowsers()

        // Keep only resolved entries, and deduplicate by (name:port:host0).
        var seen = Set<String>()
        var out: [[String: Any]] = []

        for box in discovered where box.resolved && !box.hosts.isEmpty {
            let key = "\(box.name):\(box.port):\(box.hosts.first ?? "")"
            if seen.contains(key) { continue }
            seen.insert(key)

            out.append(box.result)
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

    /// Cancel the discovery timeout.
    private func cancelTimers() {
        hardTimeout?.cancel(); hardTimeout = nil
    }

    /// Stop any active browsers.
    private func stopBrowsers() {
            nwBrowser?.cancel()
        nwBrowser = nil
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
            self.stopPublisherIfNeeded(reason: "Timed out waiting for service publish after \(self.publishTimeoutMs)ms")
        }
        publishTimeout = wi
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(publishTimeoutMs), execute: wi)
    }

    /// Normalize a service name by removing the system-appended `" (n)"` suffix.
    private func normalize(_ s: String) -> String {
        return s
            .replacingOccurrences(of: #" \(\d+\)$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: ".", with: "-")
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

extension MDNS {
    private static func validatedWatchTypes(_ types: [String]) throws -> [String] {
        guard !types.isEmpty else { throw error("Missing or empty 'types' array") }
        var unique: [String] = []
        for raw in types {
            guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw error("Invalid service type") }
            let type = try validatedType(raw)
            if !unique.contains(type) { unique.append(type) }
        }
        return unique
    }
    public var isPublishing: Bool {
        if Thread.isMainThread { return publisher != nil }
        return DispatchQueue.main.sync { publisher != nil }
    }
    internal static func validatedType(_ raw: String) throws -> String {
        var type = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if type.isEmpty { type = "_http._tcp." }
        if type.hasSuffix(".") { type.removeLast() }
        let service = type.components(separatedBy: ".").first.map { String($0.dropFirst()) } ?? ""
        guard type.range(of: "^_[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?\\._(tcp|udp)$", options: .regularExpression) != nil,
              service.range(of: "[a-z]", options: .regularExpression) != nil, !service.contains("--") else {
            throw error("Invalid service type: \(raw)")
        }
        return type + "."
    }
    internal static func validatedName(_ raw: String) throws -> String {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name.utf8.count <= 63, !raw.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
            throw error("Invalid instance name (maximum 63 UTF-8 bytes, no control characters)")
        }
        return name
    }
    internal static func validateTXT(_ txt: [String: String]?) throws {
        var keys = Set<String>()
        var totalBytes = 0
        for (key, value) in txt ?? [:] {
            guard !key.isEmpty,
                  key.unicodeScalars.allSatisfy({ (32...126).contains($0.value) && $0 != "=" }),
                  keys.insert(key.lowercased()).inserted else {
                throw error("Invalid or duplicate TXT key")
            }
            let bytes = "\(key)=\(value)".utf8.count
            totalBytes += bytes + 1
            guard totalBytes <= 1300 else { throw error("TXT record must fit in 1300 bytes including length prefixes") }
            guard bytes <= 255 else { throw error("TXT entries must be at most 255 UTF-8 bytes including key=") }
        }
    }

    /// `NWBrowser` parks in `.waiting(.dns(PolicyDenied))` when the Local Network permission is denied.
    static func isLocalNetworkDenied(_ error: NWError) -> Bool {
        if case .dns(let code) = error { return code == -65570 } // kDNSServiceErr_PolicyDenied
        return false
    }

    // MARK: - Internal: candidate handling (shared by NWBrowser and NetServiceBrowser)

    /// Register one browse result and start resolving it.
    ///
    /// The identity key is built from the *normalized* type/domain, the same values `ServiceBox`
    /// stores. `NWBrowser` re-delivers its whole result set on every change, so a key built from the
    /// raw values would never match and every change would spawn a new resolver per known service.
    internal func handleServiceFound(name: String, type: String, domain: String) {
        guard discoverCompletion != nil, matchesTarget(name) else { return }

        let normType = (type.hasSuffix(".") ? type : type + ".").lowercased()
        let normDomain = domain.isEmpty ? "local." : (domain.hasSuffix(".") ? domain : domain + ".")
        let key = keyFor(name: name, type: normType, domain: normDomain)
        if discovered.contains(where: { $0.identityKey == key }) { return }

        // Dedicated resolver (never reuse the browser's service object).
        let resolver = makeService(normDomain, normType, name, nil)
        resolver.includesPeerToPeer = true
        resolver.delegate = self

        let box = ServiceBox(name: name, type: normType, domain: normDomain)
        discovered.append(box)
        resolveMap[resolver] = box
        resolver.resolve(withTimeout: resolveTimeoutSeconds)

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
        if watchResolved(sender) { return }
        guard let box = resolveMap[sender] else { return }
        readResolved(sender, into: box)

        // This resolver is done.
        resolveMap.removeValue(forKey: sender)
        sender.stop()
        sender.delegate = nil

        // Early finish if a specific target is requested and this service matches it.
        if let t = targetName, !t.isEmpty, matchesTarget(sender.name) {
            finishDiscovery(session: discoverySession)
        }
    }

    public func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        if watchResolveFailed(sender) { return }
        // Drop the unresolved service and try to continue with others.
        guard resolveMap.removeValue(forKey: sender) != nil else { return }
        sender.delegate = nil
    }
}

// MARK: - NetServiceBrowserDelegate (fallback browsing)

extension MDNS: NetServiceBrowserDelegate {

    public func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        if watchSession?.browsers.values.contains(where: { $0 === browser }) == true {
            handleWatchFound(name: service.name, type: service.type, domain: service.domain)
            return
        }
        guard browser === nsBrowser else { return }
        handleServiceFound(name: service.name, type: service.type, domain: service.domain)
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        guard watchSession?.browsers.values.contains(where: { $0 === browser }) == true else { return }
        handleWatchLost(name: service.name, type: service.type, domain: service.domain)
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        if let type = watchSession?.browsers.first(where: { $0.value === browser })?.key {
            failWatch(type: type, error: Self.error("Failed to search for services: \(errorDict)"))
            return
        }
        guard browser === nsBrowser else { return }
        let code = (errorDict[NetService.errorCode] as NSNumber?)?.intValue ?? -1
        let err = NSError(
            domain: "mDNS.discovery",
            code: code,
            userInfo: [NSLocalizedDescriptionKey: "Failed to search for services", "info": errorDict]
        )
        finishDiscovery(session: discoverySession, error: err)
    }
}

// MARK: - Continuous discovery

public protocol MDNSWatchDelegate: AnyObject {
    func mdns(_ mdns: MDNS, didFindService service: [String: Any])
    func mdns(_ mdns: MDNS, didLoseService service: [String: Any])
    func mdns(_ mdns: MDNS, watchError type: String, message: String, watching: Bool)
}

internal struct BrowseService {
    let name: String
    let type: String
    let domain: String
}

private final class WatchSession {
    var browsers: [String: NetServiceBrowser] = [:]
    var networkBrowsers: [NWBrowser] = []
    var known: [String: ServiceBox] = [:]
    var resolvers: [NetService: ServiceBox] = [:]
    var retries: [String: DispatchWorkItem] = [:]
    var attempts: [String: Int] = [:]

    func stop() {
        for browser in networkBrowsers {
            browser.stateUpdateHandler = nil
            browser.browseResultsChangedHandler = nil
            browser.cancel()
        }
        networkBrowsers.removeAll()
        for browser in browsers.values { browser.delegate = nil; browser.stop() }
        browsers.removeAll()
        for resolver in resolvers.keys { resolver.delegate = nil; resolver.stop() }
        resolvers.removeAll()
        retries.values.forEach { $0.cancel() }
        retries.removeAll()
        known.removeAll()
        attempts.removeAll()
    }
}

extension MDNS {
    /// Thanks to Idrimi for the original continuous discovery feature (PR #7).
    public func watchServices(types: [String], useNW: Bool = true, completion: @escaping (Result<Int, Error>) -> Void) {
        runOnMain { [weak self] in
            guard let self = self else { completion(.failure(Self.error("mDNS manager released"))); return }
            let unique: [String]
            do { unique = try Self.validatedWatchTypes(types) } catch { completion(.failure(error)); return }
            self.stopWatch()
            let watch = WatchSession()
            self.watchSession = watch
            for type in unique {
                if useNW {
                    let params = NWParameters()
                    params.includePeerToPeer = true
                    let browser = NWBrowser(for: .bonjour(type: String(type.dropLast()), domain: nil), using: params)
                    watch.networkBrowsers.append(browser)
                    browser.stateUpdateHandler = { [weak self, weak watch] state in
                        guard let self = self, let watch = watch, self.watchSession === watch else { return }
                        self.handleWatchState(state, type: type)
                    }
                    browser.browseResultsChangedHandler = { [weak self, weak watch] results, _ in
                        guard let self = self, let watch = watch, self.watchSession === watch else { return }
                        let services: [BrowseService] = results.compactMap { result in
                            guard case let .service(name, type, domain, _) = result.endpoint else { return nil }
                            return BrowseService(name: name, type: type, domain: domain)
                        }
                        self.handleWatchResults(services, type: type)
                    }
                    browser.start(queue: .main)
                } else {
                    let browser = self.makeBrowser()
                    browser.includesPeerToPeer = true
                    browser.delegate = self
                    watch.browsers[type] = browser
                    browser.searchForServices(ofType: type, inDomain: "local.")
                }
            }
            completion(.success(unique.count))
        }
    }

    public func stopWatching(completion: @escaping () -> Void = {}) {
        runOnMain { [weak self] in self?.stopWatch(); completion() }
    }

    private func stopWatch() {
        let old = watchSession
        watchSession = nil
        old?.stop()
    }

    internal func failWatch(type: String, error: Error) {
        guard watchSession != nil else { return }
        stopWatch()
        watchDelegate?.mdns(self, watchError: type, message: error.localizedDescription, watching: false)
    }

    internal func handleWatchState(_ state: NWBrowser.State, type: String) {
        switch state {
        case .failed(let error): failWatch(type: type, error: error)
        case .waiting(let error) where Self.isLocalNetworkDenied(error):
            failWatch(type: type, error: Self.error("Local network access denied. Enable it in Settings > Privacy > Local Network."))
        default: break
        }
    }

    internal func handleWatchResults(_ services: [BrowseService], type: String) {
        guard let watch = watchSession else { return }
        var present = Set<String>()
        for service in services {
            let normalized = normalizedBox(name: service.name, type: service.type, domain: service.domain)
            present.insert(normalized.identityKey)
            handleWatchFound(name: service.name, type: service.type, domain: service.domain)
        }
        for box in Array(watch.known.values) where box.type == type && !present.contains(box.identityKey) {
            guard watchSession === watch else { return }
            handleWatchLost(name: box.name, type: box.type, domain: box.domain)
        }
    }

    private func normalizedBox(name: String, type: String, domain: String) -> ServiceBox {
        let type = (type.hasSuffix(".") ? type : type + ".").lowercased()
        let domain = domain.isEmpty ? "local." : (domain.hasSuffix(".") ? domain : domain + ".")
        return ServiceBox(name: name, type: type, domain: domain)
    }

    internal func handleWatchFound(name: String, type: String, domain: String) {
        guard let watch = watchSession else { return }
        let box = normalizedBox(name: name, type: type, domain: domain)
        guard watch.known[box.identityKey] == nil else { return }
        watch.known[box.identityKey] = box
        resolveWatched(box, watch: watch)
    }

    private func resolveWatched(_ box: ServiceBox, watch: WatchSession) {
        guard watchSession === watch, watch.known[box.identityKey] === box else { return }
        watch.retries.removeValue(forKey: box.identityKey)
        watch.attempts[box.identityKey, default: 0] += 1
        let service = makeService(box.domain, box.type, box.name, nil)
        service.includesPeerToPeer = true
        service.delegate = self
        watch.resolvers[service] = box
        let timeout = DispatchWorkItem { [weak self, weak watch, weak service] in
            guard let self = self, let watch = watch, let service = service, self.watchSession === watch else { return }
            _ = self.watchResolveFailed(service)
        }
        watch.retries[box.identityKey] = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + resolveTimeoutSeconds, execute: timeout)
        service.resolve(withTimeout: resolveTimeoutSeconds)
    }

    internal func handleWatchLost(name: String, type: String, domain: String) {
        guard let watch = watchSession else { return }
        let key = normalizedBox(name: name, type: type, domain: domain).identityKey
        guard let box = watch.known.removeValue(forKey: key) else { return }
        watch.retries.removeValue(forKey: key)?.cancel()
        watch.attempts.removeValue(forKey: key)
        for (resolver, pending) in Array(watch.resolvers) where pending === box {
            watch.resolvers.removeValue(forKey: resolver)
            resolver.delegate = nil
            resolver.stop()
        }
        if box.resolved { watchDelegate?.mdns(self, didLoseService: box.result) }
    }

    private func watchResolved(_ sender: NetService) -> Bool {
        guard let watch = watchSession, let box = watch.resolvers[sender] else { return false }
        readResolved(sender, into: box)
        guard !box.hosts.isEmpty else { return true }
        watch.resolvers.removeValue(forKey: sender)
        watch.retries.removeValue(forKey: box.identityKey)?.cancel()
        readResolved(sender, into: box)
        sender.stop()
        sender.delegate = nil
        guard watch.known[box.identityKey] === box else { return true }
        watchDelegate?.mdns(self, didFindService: box.result)
        return true
    }

    private func watchResolveFailed(_ sender: NetService) -> Bool {
        guard let watch = watchSession, let box = watch.resolvers.removeValue(forKey: sender) else { return false }
        watch.retries.removeValue(forKey: box.identityKey)?.cancel()
        sender.delegate = nil
        sender.stop()
        let key = box.identityKey
        if watch.attempts[key, default: 0] < 4 {
            let retry = DispatchWorkItem { [weak self, weak watch] in
                guard let self = self, let watch = watch else { return }
                self.resolveWatched(box, watch: watch)
            }
            watch.retries[key] = retry
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(150), execute: retry)
        } else {
            watch.known.removeValue(forKey: key)
            watch.attempts.removeValue(forKey: key)
            watchDelegate?.mdns(self, watchError: box.type, message: "Failed to resolve \(box.name)", watching: true)
        }
        return true
    }

    private func readResolved(_ sender: NetService, into box: ServiceBox) {
        box.port = Int(sender.port)
        box.hosts = parseHosts(sender.addresses)
        box.hostname = sender.hostName
        if let txt = sender.txtRecordData() {
            box.txt = NetService.dictionary(fromTXTRecord: txt).mapValues { String(data: $0, encoding: .utf8) ?? "" }
        }
        box.resolved = !box.hosts.isEmpty
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
    var hostname: String?
    var txt: [String: String] = [:]
    var resolved: Bool = false

    init(name: String, type: String, domain: String) {
        self.name = name
        self.type = type
        self.domain = domain
    }

    var result: [String: Any] {
        var value: [String: Any] = ["name": name, "type": type, "domain": domain, "port": port, "hosts": hosts]
        if let hostname = hostname { value["hostname"] = hostname }
        if !txt.isEmpty { value["txt"] = txt }
        return value
    }

    var identityKey: String { "\(name)|\(type)|\(domain)" }

    static func == (lhs: ServiceBox, rhs: ServiceBox) -> Bool {
        lhs.identityKey == rhs.identityKey
    }
    func hash(into hasher: inout Hasher) { hasher.combine(identityKey) }
}

// MARK: - Address utilities

/// Convert `NetService.addresses` to numeric IPv4/IPv6 strings.
func parseHosts(_ addrs: [Data]?) -> [String] {
    guard let addrs = addrs, !addrs.isEmpty else { return [] }
    var out: [String] = []
    out.reserveCapacity(addrs.count)

    for data in addrs {
        data.withUnsafeBytes { raw in
            guard raw.count >= MemoryLayout<sockaddr>.size, let base = raw.baseAddress else { return }
            let sa = base.assumingMemoryBound(to: sockaddr.self)
            let family = Int32(sa.pointee.sa_family)

            if family == AF_INET, raw.count >= MemoryLayout<sockaddr_in>.size {
                var addr = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
                var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                if inet_ntop(AF_INET, &addr, &buf, socklen_t(INET_ADDRSTRLEN)) != nil {
                    out.append(String(cString: buf))
                }
            } else if family == AF_INET6, raw.count >= MemoryLayout<sockaddr_in6>.size {
                let address = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee }
                var addr6 = address.sin6_addr
                var buf6 = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
                if inet_ntop(AF_INET6, &addr6, &buf6, socklen_t(INET6_ADDRSTRLEN)) != nil {
                    let host = String(cString: buf6)
                    out.append(address.sin6_scope_id == 0 ? host : "\(host)%\(address.sin6_scope_id)")
                }
            }
        }
    }
    return out.filter { !$0.contains(":") } + out.filter { $0.contains(":") }
}
