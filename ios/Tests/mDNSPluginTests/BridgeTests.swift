import Capacitor
import XCTest
@testable import mDNSPlugin

final class BridgeTests: XCTestCase {
    private func invoke(_ method: String, options: [String: Any], perform: (CAPPluginCall) -> Void) throws -> [String: Any] {
        var result: [String: Any]?
        let call = try XCTUnwrap(CAPPluginCall(
            callbackId: "test", methodName: method, options: options,
            success: { response, _ in result = response?.data },
            error: { _ in XCTFail("Invalid input must resolve with error: true") }
        ))
        perform(call)
        return try XCTUnwrap(result)
    }

    func testBroadcastRejectsInvalidRawBridgeValues() throws {
        let plugin = mDNSPlugin()
        let cases: [[String: Any]] = [
            ["port": 80.5], ["port": true], ["port": "80"], ["port": Double.nan],
            ["port": 0], ["port": 65536], ["port": 80, "txt": ["a": 1]],
            ["port": 80, "txt": ["a": true]], ["port": 80, "type": 1], ["port": 80, "name": true]
        ]
        for options in cases {
            let result = try invoke("startBroadcast", options: options, perform: plugin.startBroadcast)
            XCTAssertEqual(result["error"] as? Bool, true, "\(options)")
            XCTAssertEqual(result["publishing"] as? Bool, false)
            XCTAssertEqual(result["name"] as? String, "")
            XCTAssertFalse(try XCTUnwrap(result["errorMessage"] as? String).isEmpty)
        }
    }

    func testDiscoveryRejectsInvalidRawBridgeValues() throws {
        let plugin = mDNSPlugin()
        let cases: [[String: Any]] = [
            ["timeout": true], ["timeout": "50"], ["timeout": Double.nan],
            ["timeout": Double.infinity], ["type": 1], ["name": true]
        ]
        for options in cases {
            let result = try invoke("discover", options: options, perform: plugin.discover)
            XCTAssertEqual(result["error"] as? Bool, true)
            XCTAssertEqual(result["servicesFound"] as? Int, 0)
            XCTAssertTrue(try XCTUnwrap(result["services"] as? [Any]).isEmpty)
        }
    }
}
