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

        let verificationScreen = element(identifier: "verification.screen")
        XCTAssertTrue(
            verificationScreen.waitForExistence(timeout: 15),
            "The real order request did not reach the in-app verification result."
        )

        let verificationStatus = element(identifier: "verification.status")
        XCTAssertTrue(verificationStatus.waitForExistence(timeout: 2))
        XCTAssertTrue(
            verificationStatus.label.localizedCaseInsensitiveContains("FEATURE VERIFIED"),
            "The final app screen does not visibly report feature verification."
        )

        let expectedArmLabel = ProcessInfo.processInfo.environment["MOOPS_BENCHMARK_ARM_LABEL"]
            ?? "CODEX + UITEST"
        let verificationArm = element(identifier: "verification.arm")
        XCTAssertTrue(verificationArm.waitForExistence(timeout: 2))
        XCTAssertEqual(
            verificationArm.label,
            expectedArmLabel,
            "The final app screen does not identify the benchmark setup."
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
        app.launchEnvironment["MOOPS_BENCHMARK_ARM_LABEL"] =
            ProcessInfo.processInfo.environment["MOOPS_BENCHMARK_ARM_LABEL"]
            ?? "CODEX + UITEST"
        if let startEpoch = ProcessInfo.processInfo.environment["MOOPS_BENCHMARK_START_EPOCH_MS"] {
            app.launchEnvironment["MOOPS_BENCHMARK_START_EPOCH_MS"] = startEpoch
        }
        if let backendBaseURL = ProcessInfo.processInfo.environment["MOOPS_BACKEND_BASE_URL"] {
            app.launchEnvironment["MOOPS_BACKEND_BASE_URL"] = backendBaseURL
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

/// The narrow public-UI bridge used by the MOOPS host adapter. Each invocation
/// handles exactly one request so the host remains the workflow orchestrator.
final class MOOPSAdapterUITests: XCTestCase {
    func testMOOPSAdapterCommand() throws {
        guard let requestJSON = ProcessInfo.processInfo.environment["MOOPS_UI_REQUEST"] else {
            throw XCTSkip("MOOPS_UI_REQUEST is only supplied by the MOOPS UI adapter.")
        }

        do {
            let request = try decodeRequest(requestJSON)
            let app = XCUIApplication(bundleIdentifier: request.bundleID)

            guard app.state == .runningForeground else {
                throw AdapterError.appNotForeground(request.bundleID)
            }

            switch request.operation {
            case "perform":
                guard let step = request.step else {
                    throw AdapterError.missingStep
                }
                try perform(step, in: app)
                emit(["ok": true])
            case "restore-and-inspect":
                guard !request.trace.isEmpty else {
                    throw AdapterError.missingTrace
                }
                for step in request.trace {
                    try perform(step, in: app)
                }
                emit([
                    "ok": true,
                    "observation": ["nodes": accessibilityNodes(in: app)]
                ])
            case "inspect":
                emit([
                    "ok": true,
                    "observation": ["nodes": accessibilityNodes(in: app)]
                ])
            default:
                throw AdapterError.unsupportedOperation(request.operation)
            }
        } catch {
            emit(["ok": false, "error": error.localizedDescription])
            XCTFail(error.localizedDescription)
        }
    }

    private func perform(_ step: AdapterStep, in app: XCUIApplication) throws {
        let element = matchingElement(step.selector, in: app)

        switch step.operation {
        case "wait":
            let timeout = TimeInterval(step.timeoutMilliseconds ?? 10_000) / 1_000
            guard element.waitForExistence(timeout: timeout) else {
                throw AdapterError.elementNotFound(step.selector)
            }
        case "tap":
            guard element.waitForExistence(timeout: 5) else {
                throw AdapterError.elementNotFound(step.selector)
            }
            guard element.isHittable else {
                throw AdapterError.elementNotHittable(step.selector)
            }
            element.tap()
        default:
            throw AdapterError.unsupportedStep(step.operation)
        }
    }

    private func matchingElement(_ selector: AdapterSelector, in app: XCUIApplication) -> XCUIElement {
        let all = app.descendants(matching: .any)
        switch selector.channel {
        case "id":
            return all.matching(identifier: selector.value).firstMatch
        case "label":
            return all.matching(NSPredicate(format: "label == %@", selector.value)).firstMatch
        case "text":
            return all.matching(
                NSPredicate(format: "label == %@ OR value == %@", selector.value, selector.value)
            ).firstMatch
        case "value":
            return all.matching(NSPredicate(format: "value == %@", selector.value)).firstMatch
        default:
            return all.matching(identifier: "__unsupported_selector__").firstMatch
        }
    }

    private func accessibilityNodes(in app: XCUIApplication) -> [[String: Any]] {
        app.descendants(matching: .any).allElementsBoundByAccessibilityElement.compactMap { element in
            let value = publicScalar(element.value)
            let text = element.label.isEmpty ? (value as? String ?? "") : element.label
            guard !element.identifier.isEmpty || !element.label.isEmpty || !text.isEmpty else {
                return nil
            }
            return [
                "id": element.identifier,
                "label": element.label,
                "text": text,
                "value": value,
                "enabled": element.isEnabled
            ]
        }
    }

    private func publicScalar(_ value: Any?) -> Any {
        switch value {
        case let string as String:
            return string
        case let number as NSNumber:
            return number
        default:
            return ""
        }
    }

    private func decodeRequest(_ json: String) throws -> AdapterRequest {
        guard let data = json.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["protocolVersion"] as? Int == 1,
              let operation = object["operation"] as? String,
              let target = object["target"] as? [String: Any],
              let bundleID = target["bundleId"] as? String else {
            throw AdapterError.invalidRequest
        }

        let step = try (object["step"] as? [String: Any]).map(decodeStep)
        let trace = try (object["trace"] as? [[String: Any]] ?? []).map(decodeStep)
        return AdapterRequest(operation: operation, bundleID: bundleID, step: step, trace: trace)
    }

    private func decodeStep(_ rawStep: [String: Any]) throws -> AdapterStep {
        guard let stepOperation = rawStep["op"] as? String,
              let rawSelector = rawStep["selector"] as? [String: Any],
              let channel = rawSelector["by"] as? String,
              ["id", "label", "text", "value"].contains(channel),
              let value = rawSelector["value"] as? String else {
            throw AdapterError.invalidRequest
        }
        return AdapterStep(
            operation: stepOperation,
            selector: AdapterSelector(channel: channel, value: value),
            timeoutMilliseconds: rawStep["timeoutMs"] as? Int
        )
    }

    private func emit(_ response: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else {
            XCTFail("Could not encode the MOOPS UI response.")
            return
        }
        print("MOOPS_UI_RESPONSE:\(json)")
    }
}

private struct AdapterRequest {
    let operation: String
    let bundleID: String
    let step: AdapterStep?
    let trace: [AdapterStep]
}

private struct AdapterStep {
    let operation: String
    let selector: AdapterSelector
    let timeoutMilliseconds: Int?
}

private struct AdapterSelector: CustomStringConvertible {
    let channel: String
    let value: String

    var description: String { "\(channel)=\(value)" }
}

private enum AdapterError: LocalizedError {
    case invalidRequest
    case appNotForeground(String)
    case missingStep
    case missingTrace
    case unsupportedOperation(String)
    case unsupportedStep(String)
    case elementNotFound(AdapterSelector)
    case elementNotHittable(AdapterSelector)

    var errorDescription: String? {
        switch self {
        case .invalidRequest:
            return "MOOPS_UI_REQUEST is not a supported protocol-v1 request."
        case .appNotForeground(let bundleID):
            return "The target app \(bundleID) is not running in the foreground."
        case .missingStep:
            return "A perform request requires one step."
        case .missingTrace:
            return "A restore-and-inspect request requires a nonempty trace."
        case .unsupportedOperation(let operation):
            return "Unsupported UI operation: \(operation)."
        case .unsupportedStep(let operation):
            return "Unsupported UI step: \(operation)."
        case .elementNotFound(let selector):
            return "No public accessibility element matched \(selector)."
        case .elementNotHittable(let selector):
            return "The public accessibility element matching \(selector) is not hittable."
        }
    }
}
