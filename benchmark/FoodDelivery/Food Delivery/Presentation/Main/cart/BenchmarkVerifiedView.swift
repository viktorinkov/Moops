import SwiftUI

enum BenchmarkVerificationStore {
    private static let preferenceKey = "benchmark.lastVerification.preference"
    private static let runIDKey = "benchmark.lastVerification.runID"

    static func record(
        _ preference: DeliveryPreference,
        for run: BenchmarkRunContext? = BenchmarkRunContext.current
    ) {
        guard let run else { return }
        UserDefaults.standard.set(preference.rawValue, forKey: preferenceKey)
        UserDefaults.standard.set(run.runID, forKey: runIDKey)
    }

    static func preference(for run: BenchmarkRunContext) -> DeliveryPreference? {
        guard UserDefaults.standard.string(forKey: runIDKey) == run.runID else { return nil }
        return UserDefaults.standard.string(forKey: preferenceKey)
            .flatMap(DeliveryPreference.init(rawValue:))
    }
}

struct BenchmarkVerifiedView: View {
    let deliveryPreference: DeliveryPreference

    private var armLabel: String {
        BenchmarkRunContext.current?.armLabel ?? "CODEX + UITEST"
    }

    var body: some View {
        ZStack {
            Color(red: 0.03, green: 0.62, blue: 0.28)
                .ignoresSafeArea()

            VStack(spacing: 18) {
                Text("Verified result")
                    .frame(width: 1, height: 1)
                    .opacity(0.01)
                    .accessibilityIdentifier("verification.screen")

                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 88, weight: .bold))
                    .foregroundColor(.white)

                Text("FEATURE VERIFIED")
                    .font(.system(size: 34, weight: .black, design: .rounded))
                    .foregroundColor(.white)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("verification.status")

                Text(deliveryPreference.rawValue)
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    .foregroundColor(.white.opacity(0.9))

                Text(armLabel)
                    .font(.system(size: 15, weight: .bold, design: .monospaced))
                    .foregroundColor(.white)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .background(Color.black.opacity(0.24))
                    .clipShape(Capsule())
                    .accessibilityIdentifier("verification.arm")

                Text("ORDER ACCEPTED BY LOCAL BACKEND")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundColor(.white.opacity(0.75))
            }
            .padding(24)
        }
    }
}
