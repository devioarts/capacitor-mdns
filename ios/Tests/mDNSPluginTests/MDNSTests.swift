import XCTest
import Network
@testable import mDNSPlugin

// MARK: - Fakes

/// `NetService` that never touches the network; tests drive the delegate callbacks by hand.
private final class FakeNetService: NetService {
    var resolveCalls = 0
    var publishCalls = 0
    var stopCalls = 0
    var fakePort = 8080
    var fakeAddresses: [Data]?
    var fakeTXT: Data?

    override func resolve(withTimeout timeout: TimeInterval) { resolveCalls += 1 }
    override func publish() { publishCalls += 1 }
    override func stop() { stopCalls += 1 }
    override var port: Int { fakePort }
    override var addresses: [Data]? { fakeAddresses }
    override func txtRecordData() -> Data? { fakeTXT }
}

private final class FakeBrowser: NetServiceBrowser {
    override func searchForServices(ofType type: String, inDomain domainString: String) {}
    override func stop() {}
}

private final class Rig {
    let mdns = MDNS()
    var services: [FakeNetService] = []

    init(settleMs: Int = 30, publishTimeoutMs: Int = 5000) {
        mdns.settleDebounceMs = settleMs
        mdns.publishTimeoutMs = publishTimeoutMs
        mdns.makeBrowser = { FakeBrowser() }
        mdns.makeService = { [weak self] domain, type, name, port in
            let s = port.map { FakeNetService(domain: domain, type: type, name: name, port: $0) }
                ?? FakeNetService(domain: domain, type: type, name: name)
            self?.services.append(s)
            return s
        }
    }

    /// Start a discovery on the fallback browser and record its outcome.
    func discover(name: String? = nil, timeoutMs: Int = 2000, outcome: @escaping (Result<[[String: Any]], Error>) -> Void) {
        mdns.discover(type: "_http._tcp.", name: name, timeoutMs: timeoutMs, useNW: false, completion: outcome)
    }

    func found(_ name: String, type: String = "_http._tcp.", domain: String = "local.") {
        mdns.handleServiceFound(name: name, type: type, domain: domain)
    }

    func resolve(_ service: FakeNetService, host: String = "192.168.1.5") {
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        inet_pton(AF_INET, host, &addr.sin_addr)
        service.fakeAddresses = [withUnsafeBytes(of: &addr) { Data($0) }]
        mdns.netServiceDidResolveAddress(service)
    }
}

// MARK: - Tests

final class MDNSTests: XCTestCase {

    private func pause(_ seconds: TimeInterval) {
        let e = expectation(description: "delay")
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { e.fulfill() }
        wait(for: [e], timeout: seconds + 2)
    }

    // MARK: Discovery

    func testSlowResolveDoesNotFinishBeforeTheServiceIsResolved() {
        let rig = Rig(settleMs: 30)
        var outcome: Result<[[String: Any]], Error>?
        let done = expectation(description: "discovery")
        rig.discover { outcome = $0; done.fulfill() }

        rig.found("A")
        pause(0.15) // several debounce windows pass while the resolver is still outstanding
        XCTAssertNil(outcome, "must not settle while a resolver is pending")

        rig.resolve(rig.services[0])
        wait(for: [done], timeout: 2)

        guard case .success(let services)? = outcome else { return XCTFail("expected success") }
        XCTAssertEqual(services.count, 1)
        XCTAssertEqual(services.first?["name"] as? String, "A")
        XCTAssertEqual(services.first?["port"] as? Int, 8080)
        XCTAssertEqual(services.first?["hosts"] as? [String], ["192.168.1.5"])
    }

    func testRepeatedBrowseResultsDoNotSpawnDuplicateResolvers() {
        let rig = Rig()
        rig.discover { _ in }

        // NWBrowser redelivers its full result set on every change, with un-normalized type/domain.
        rig.found("A", type: "_http._tcp", domain: "local")
        rig.found("A", type: "_http._tcp", domain: "local")
        rig.found("A", type: "_http._tcp.", domain: "local.")
        rig.found("A", type: "_http._tcp", domain: "")

        XCTAssertEqual(rig.services.count, 1)
        XCTAssertEqual(rig.services[0].resolveCalls, 1)
    }

    func testTargetNameFiltersCandidatesAndFinishesEarly() {
        let rig = Rig()
        var outcome: Result<[[String: Any]], Error>?
        let done = expectation(description: "discovery")
        rig.discover(name: "Foo", timeoutMs: 10_000) { outcome = $0; done.fulfill() }

        rig.found("Other")
        XCTAssertEqual(rig.services.count, 0, "non-matching candidates must not be resolved")

        rig.found("Foo (2)")
        XCTAssertEqual(rig.services.count, 1)
        rig.resolve(rig.services[0])
        wait(for: [done], timeout: 1) // early exit, long before the 10s hard timeout

        guard case .success(let services)? = outcome else { return XCTFail("expected success") }
        XCTAssertEqual(services.compactMap { $0["name"] as? String }, ["Foo (2)"])
    }

    func testHardTimeoutReturnsOnlyResolvedServices() {
        let rig = Rig()
        var outcome: Result<[[String: Any]], Error>?
        let done = expectation(description: "discovery")
        rig.discover(timeoutMs: 80) { outcome = $0; done.fulfill() }

        rig.found("NeverResolves")
        wait(for: [done], timeout: 2)

        guard case .success(let services)? = outcome else { return XCTFail("expected success") }
        XCTAssertTrue(services.isEmpty)
    }

    func testUnresolvableServiceDoesNotBlockSettling() {
        let rig = Rig(settleMs: 30)
        var outcome: Result<[[String: Any]], Error>?
        let done = expectation(description: "discovery")
        rig.discover { outcome = $0; done.fulfill() }

        rig.found("Bad")
        rig.found("Good")
        rig.mdns.netService(rig.services[0], didNotResolve: [:])
        rig.resolve(rig.services[1])
        wait(for: [done], timeout: 2)

        guard case .success(let services)? = outcome else { return XCTFail("expected success") }
        XCTAssertEqual(services.compactMap { $0["name"] as? String }, ["Good"])
    }

    func testNewDiscoveryReplacesTheOldOneAndIgnoresItsStaleCallbacks() {
        let rig = Rig()
        var first: Result<[[String: Any]], Error>?
        var second: Result<[[String: Any]], Error>?
        rig.discover { first = $0 }
        rig.found("Old")
        let stale = rig.services[0]

        rig.discover { second = $0 }
        guard case .failure(let err)? = first else { return XCTFail("first discovery must fail as replaced") }
        XCTAssertTrue(err.localizedDescription.contains("replaced"))

        rig.resolve(stale) // callback from the previous session
        pause(0.1)
        XCTAssertNil(second, "a stale resolver must not complete the new discovery")
    }

    // MARK: Publishing

    func testPublishSuccessReportsServiceName() {
        let rig = Rig()
        var outcome: Result<String, Error>?
        rig.mdns.broadcast(type: "_http._tcp.", name: "Svc", port: 8080, txt: ["k": "v"]) { outcome = $0 }

        let svc = rig.services[0]
        XCTAssertEqual(svc.publishCalls, 1)
        rig.mdns.netServiceDidPublish(svc)

        guard case .success(let name)? = outcome else { return XCTFail("expected success") }
        XCTAssertEqual(name, "Svc")
    }

    func testPublishTimeoutFailsAndStopsThePublisher() {
        let rig = Rig(publishTimeoutMs: 50)
        let done = expectation(description: "publish")
        var outcome: Result<String, Error>?
        rig.mdns.broadcast(type: "_http._tcp.", name: "Svc", port: 8080, txt: nil) { outcome = $0; done.fulfill() }
        wait(for: [done], timeout: 2)

        guard case .failure(let err)? = outcome else { return XCTFail("expected failure") }
        XCTAssertTrue(err.localizedDescription.contains("Timed out"))
        XCTAssertEqual(rig.services[0].stopCalls, 1)
    }

    func testNewBroadcastFailsThePreviousPendingOne() {
        let rig = Rig()
        var first: Result<String, Error>?
        var second: Result<String, Error>?
        rig.mdns.broadcast(type: "_http._tcp.", name: "A", port: 1, txt: nil) { first = $0 }
        rig.mdns.broadcast(type: "_http._tcp.", name: "B", port: 2, txt: nil) { second = $0 }

        guard case .failure(let err)? = first else { return XCTFail("first broadcast must fail as replaced") }
        XCTAssertTrue(err.localizedDescription.contains("Replaced"))
        XCTAssertNil(second)
        XCTAssertEqual(rig.services[0].stopCalls, 1)

        rig.mdns.netServiceDidPublish(rig.services[0]) // stale publisher: ignored
        XCTAssertNil(second)
        rig.mdns.netServiceDidPublish(rig.services[1])
        guard case .success(let name)? = second else { return XCTFail("expected success") }
        XCTAssertEqual(name, "B")
    }

    func testDidNotPublishReportsErrorAndAllowsRepublishing() {
        let rig = Rig()
        var first: Result<String, Error>?
        rig.mdns.broadcast(type: "_http._tcp.", name: "A", port: 1, txt: nil) { first = $0 }
        rig.mdns.netService(rig.services[0], didNotPublish: [NetService.errorCode: NSNumber(value: -72001)])

        guard case .failure(let err)? = first else { return XCTFail("expected failure") }
        XCTAssertEqual((err as NSError).code, -72001)

        var second: Result<String, Error>?
        rig.mdns.broadcast(type: "_http._tcp.", name: "A", port: 1, txt: nil) { second = $0 }
        rig.mdns.netServiceDidPublish(rig.services[1])
        guard case .success? = second else { return XCTFail("expected success") }
    }

    func testStopBroadcastIsIdempotentAndFailsAPendingPublish() throws {
        let rig = Rig()
        var outcome: Result<String, Error>?
        rig.mdns.broadcast(type: "_http._tcp.", name: "A", port: 1, txt: nil) { outcome = $0 }

        try rig.mdns.stopBroadcast()
        try rig.mdns.stopBroadcast()

        guard case .failure? = outcome else { return XCTFail("pending publish must be failed by stop") }
        XCTAssertEqual(rig.services[0].stopCalls, 1)
    }

    func testInvalidPortFailsImmediately() {
        let rig = Rig()
        for port in [0, -1, 65536] {
            var outcome: Result<String, Error>?
            rig.mdns.broadcast(type: "_http._tcp.", name: "A", port: port, txt: nil) { outcome = $0 }
            guard case .failure? = outcome else { return XCTFail("port \(port) must be rejected") }
        }
        XCTAssertTrue(rig.services.isEmpty)
    }

    // MARK: Helpers

    func testParseHostsHandlesIPv4AndIPv6() {
        var v4 = sockaddr_in()
        v4.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        v4.sin_family = sa_family_t(AF_INET)
        inet_pton(AF_INET, "10.1.2.3", &v4.sin_addr)

        var v6 = sockaddr_in6()
        v6.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
        v6.sin6_family = sa_family_t(AF_INET6)
        inet_pton(AF_INET6, "fe80::1", &v6.sin6_addr)

        let hosts = parseHosts([withUnsafeBytes(of: &v4) { Data($0) }, withUnsafeBytes(of: &v6) { Data($0) }])
        XCTAssertEqual(hosts, ["10.1.2.3", "fe80::1"])
        XCTAssertEqual(parseHosts(nil), [])
        XCTAssertEqual(parseHosts([]), [])
    }

    func testLocalNetworkDeniedDetection() {
        XCTAssertTrue(MDNS.isLocalNetworkDenied(.dns(-65570)))
        XCTAssertFalse(MDNS.isLocalNetworkDenied(.dns(-65537)))
        XCTAssertFalse(MDNS.isLocalNetworkDenied(.posix(.ECONNREFUSED)))
    }
}
