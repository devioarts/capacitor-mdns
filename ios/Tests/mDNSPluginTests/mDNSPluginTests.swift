import XCTest
@testable import mDNSPlugin

class mDNSTests: XCTestCase {
    func testManagerCanBeCreated() {
        let implementation = MDNS()
        XCTAssertNotNil(implementation)
    }
}
