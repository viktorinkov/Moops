import Foundation
import XCTest

final class BenchmarkFlowUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        executionTimeAllowance = 180

        if app.state != .notRunning {
            app.terminate()
        }
    }

    func test1BaselineSetupReachesPopulatedCheckout() {
        launchAndRestoreToCheckout()
        assertFreshCheckoutLanding()
    }

    func test2CheckpointRestoreReacquiresCheckoutAfterRelaunch() {
        launchAndRestoreToCheckout()
        assertFreshCheckoutLanding()

        app.terminate()

        launchAndRestoreToCheckout()
        assertFreshCheckoutLanding()
    }

    func test3DeliveryPreferenceAcceptance() throws {
        launchAndRestoreToCheckout()
        assertFreshCheckoutLanding()

        let preference = element(identifier: "checkout.deliveryPreference")
        XCTAssertTrue(
            preference.waitForExistence(timeout: 5),
            "The normalized fixture must fail here until the benchmark feature adds checkout.deliveryPreference."
        )

        chooseMeetAtDoor(using: preference)
        XCTAssertTrue(waitForMeetAtDoor(), "Delivery preference did not change to Meet at door.")

        app.terminate()

        launchAndRestoreToCheckout()
        assertFreshCheckoutLanding()
        XCTAssertTrue(
            waitForMeetAtDoor(),
            "Meet at door was not retained after terminating and relaunching the installed app."
        )

        let placeOrder = element(identifier: "checkout.placeOrder")
        XCTAssertTrue(placeOrder.waitForExistence(timeout: 5), "Place-order control is missing.")
        XCTAssertTrue(placeOrder.isEnabled, "Place-order control is disabled.")
        placeOrder.tap()

        let confirmation = app.alerts["Order"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5), "Order confirmation did not appear.")
        confirmation.buttons["Yes"].tap()

        XCTAssertTrue(
            app.alerts["Success"].waitForExistence(timeout: 15),
            "The real order request did not complete successfully."
        )

        let receipt = try fetchLastOrderReceipt()
        XCTAssertEqual(
            stringValue(forKey: "delivery_preference", in: receipt),
            "Meet at door",
            "The local backend did not record the selected delivery_preference."
        )
    }

    private func launchAndRestoreToCheckout() {
        if ProcessInfo.processInfo.environment["MOOPS_ENABLE_INJECTIONIII"] == "1" {
            app.launchEnvironment["MOOPS_ENABLE_INJECTIONIII"] = "1"
        }
        app.launch()

        authenticateIfNeeded()

        XCTAssertTrue(
            element(identifier: "screen.home").waitForExistence(timeout: 15),
            "A persisted authenticated session did not reach Home."
        )
        XCTAssertTrue(
            element(identifier: "home.catalogReady").waitForExistence(timeout: 15),
            "The deterministic backend catalog did not become ready."
        )

        populateCartIfNeeded()

        XCTAssertTrue(
            element(identifier: "home.cart.itemCount").waitForExistence(timeout: 5),
            "The persisted Core Data cart is empty."
        )

        let cart = element(identifier: "home.cart")
        XCTAssertTrue(cart.waitForExistence(timeout: 5), "The public Home-to-Cart control is missing.")
        cart.tap()

        XCTAssertTrue(
            element(identifier: "screen.cart").waitForExistence(timeout: 10),
            "The public navigation path did not reach Cart."
        )
    }

    private func authenticateIfNeeded() {
        let reachedEntryPoint = XCTNSPredicateExpectation(
            predicate: NSPredicate { [weak self] _, _ in
                guard let self else { return false }
                return self.element(identifier: "screen.home").exists
                    || self.element(identifier: "start.login").exists
                    || self.element(identifier: "login.email").exists
            },
            object: nil
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [reachedEntryPoint], timeout: 15),
            .completed,
            "The app did not reach Home or the public sign-in flow."
        )

        if element(identifier: "screen.home").exists {
            return
        }

        let startLogin = element(identifier: "start.login")
        if startLogin.exists {
            startLogin.tap()
        }

        let email = element(identifier: "login.email")
        XCTAssertTrue(email.waitForExistence(timeout: 5), "Email field is missing from sign-in.")
        email.tap()
        email.typeText("demo@moops.local")

        let password = element(identifier: "login.password")
        XCTAssertTrue(password.waitForExistence(timeout: 5), "Password field is missing from sign-in.")
        password.tap()
        password.typeText("moops-demo")

        let submit = element(identifier: "login.submit")
        XCTAssertTrue(submit.waitForExistence(timeout: 5), "Sign-in button is missing.")
        submit.tap()

        XCTAssertTrue(
            element(identifier: "screen.home").waitForExistence(timeout: 15),
            "The deterministic demo credentials did not authenticate."
        )
    }

    private func populateCartIfNeeded() {
        if element(identifier: "home.cart.itemCount").exists {
            return
        }

        let firstAdd = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "cart.add."))
            .firstMatch
        XCTAssertTrue(firstAdd.waitForExistence(timeout: 10), "No backend catalog item can be added to cart.")

        firstAdd.tap()
        XCTAssertTrue(
            waitForCartCount("1", timeout: 5),
            "The first public add-to-cart action did not persist."
        )

        firstAdd.tap()
        XCTAssertTrue(
            waitForCartCount("2", timeout: 5),
            "The second public add-to-cart action did not persist."
        )
    }

    private func waitForCartCount(_ expected: String, timeout: TimeInterval) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate { [weak self] _, _ in
                guard let cart = self?.element(identifier: "home.cart"), cart.exists else {
                    return false
                }
                let value = cart.value as? String ?? ""
                return value == expected || value.hasPrefix("\(expected) ")
            },
            object: nil
        )
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func assertFreshCheckoutLanding() {
        XCTAssertTrue(
            element(identifier: "checkout.ready").waitForExistence(timeout: 15),
            "Checkout did not expose its ready predicate."
        )
        XCTAssertTrue(
            element(identifier: "checkout.total").waitForExistence(timeout: 5),
            "Backend-priced checkout total is missing."
        )
        XCTAssertTrue(
            app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH %@", "cart.item."))
                .firstMatch
                .waitForExistence(timeout: 5),
            "Checkout has no persisted cart rows."
        )
        XCTAssertFalse(
            app.textFields["Comments"].exists,
            "The normalized fixture must not retain the pre-existing generic comments shortcut."
        )
    }

    private func chooseMeetAtDoor(using preference: XCUIElement) {
        let embeddedChoice = preference.buttons["Meet at door"].firstMatch
        if embeddedChoice.exists {
            embeddedChoice.tap()
            return
        }

        let visibleChoice = app.buttons["Meet at door"].firstMatch
        if visibleChoice.exists {
            visibleChoice.tap()
            return
        }

        preference.tap()

        let menuChoice = app.buttons["Meet at door"].firstMatch
        if menuChoice.waitForExistence(timeout: 3) {
            menuChoice.tap()
            return
        }

        let textChoice = app.staticTexts["Meet at door"].firstMatch
        XCTAssertTrue(textChoice.waitForExistence(timeout: 2), "Meet at door choice is not accessible.")
        textChoice.tap()
    }

    private func waitForMeetAtDoor(timeout: TimeInterval = 5) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate { [weak self] _, _ in
                self?.preferenceShowsMeetAtDoor() == true
            },
            object: nil
        )
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func preferenceShowsMeetAtDoor() -> Bool {
        let preference = element(identifier: "checkout.deliveryPreference")
        guard preference.exists else { return false }

        let exposedText = [preference.label, preference.value as? String]
            .compactMap { $0 }
            .joined(separator: " ")
        if exposedText.localizedCaseInsensitiveContains("Meet at door") {
            return true
        }

        let choice = preference.buttons["Meet at door"].firstMatch
        let choiceValue = choice.value as? String ?? ""
        return choice.exists && ["1", "selected", "true"].contains(choiceValue.lowercased())
    }

    private func element(identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func fetchLastOrderReceipt() throws -> Any {
        let baseURL = ProcessInfo.processInfo.environment["MOOPS_BACKEND_BASE_URL"]
            ?? "http://127.0.0.1:8055"
        guard let url = URL(string: baseURL)?.appendingPathComponent("__benchmark/last-order") else {
            throw ReceiptError.invalidBackendURL(baseURL)
        }

        let completed = expectation(description: "GET /__benchmark/last-order")
        var responseData: Data?
        var responseError: Error?
        var statusCode: Int?

        URLSession.shared.dataTask(with: url) { data, response, error in
            responseData = data
            responseError = error
            statusCode = (response as? HTTPURLResponse)?.statusCode
            completed.fulfill()
        }.resume()

        wait(for: [completed], timeout: 10)

        if let responseError {
            throw responseError
        }
        guard statusCode == 200, let responseData else {
            throw ReceiptError.invalidResponse(statusCode)
        }
        return try JSONSerialization.jsonObject(with: responseData)
    }

    private func stringValue(forKey key: String, in value: Any) -> String? {
        if let object = value as? [String: Any] {
            if let match = object[key] as? String {
                return match
            }
            for child in object.values {
                if let match = stringValue(forKey: key, in: child) {
                    return match
                }
            }
        } else if let array = value as? [Any] {
            for child in array {
                if let match = stringValue(forKey: key, in: child) {
                    return match
                }
            }
        }
        return nil
    }
}

private enum ReceiptError: LocalizedError {
    case invalidBackendURL(String)
    case invalidResponse(Int?)

    var errorDescription: String? {
        switch self {
        case .invalidBackendURL(let value):
            return "Invalid MOOPS backend URL: \(value)"
        case .invalidResponse(let statusCode):
            return "Receipt endpoint returned HTTP \(statusCode.map(String.init) ?? "none")"
        }
    }
}
