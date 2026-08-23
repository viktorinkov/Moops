import Foundation

struct BenchmarkRunContext {
    static let current: BenchmarkRunContext? = {
        let environment = ProcessInfo.processInfo.environment
        guard
            let armLabel = environment["MOOPS_BENCHMARK_ARM_LABEL"],
            !armLabel.isEmpty,
            let startValue = environment["MOOPS_BENCHMARK_START_EPOCH_MS"],
            let startMilliseconds = Double(startValue)
        else {
            return nil
        }

        return BenchmarkRunContext(
            armLabel: armLabel,
            startedAt: Date(timeIntervalSince1970: startMilliseconds / 1_000)
        )
    }()

    let armLabel: String
    let startedAt: Date

    func formattedElapsed(at date: Date) -> String {
        let elapsedSeconds = max(0, Int(date.timeIntervalSince(startedAt)))
        let hours = elapsedSeconds / 3_600
        let minutes = (elapsedSeconds % 3_600) / 60
        let seconds = elapsedSeconds % 60
        return [hours, minutes, seconds]
            .map(Self.twoDigits)
            .joined(separator: ":")
    }

    private static func twoDigits(_ value: Int) -> String {
        value < 10 ? "0\(value)" : String(value)
    }
}
