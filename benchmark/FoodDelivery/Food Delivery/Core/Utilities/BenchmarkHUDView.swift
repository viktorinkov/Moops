import Combine
import SwiftUI

struct BenchmarkHUDView: View {
    let context: BenchmarkRunContext

    @State private var now = Date()
    private let clock = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 12) {
            Text(context.armLabel)
                .font(.headline)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .accessibilityIdentifier("benchmark.arm")

            Divider()
                .overlay(Color.white)
                .frame(height: 24)

            Text(context.formattedElapsed(at: now))
                .font(.body.monospacedDigit())
                .accessibilityLabel("Elapsed benchmark time")
                .accessibilityIdentifier("benchmark.timer")
        }
        .foregroundColor(.white)
        .padding(.horizontal)
        .padding(.vertical, 10)
        .fixedSize(horizontal: false, vertical: true)
        .background(Color.black.opacity(0.88))
        .clipShape(Capsule())
        .overlay(Capsule().stroke(Color.white, lineWidth: 1))
        .padding(.horizontal)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("benchmark.hud")
        .allowsHitTesting(false)
        .onReceive(clock) { now = $0 }
    }
}
