import Foundation

enum DeliveryPreference: String, CaseIterable, Codable, Identifiable {
    case leaveAtDoor = "Leave at door"
    case meetAtDoor = "Meet at door"

    var id: String { rawValue }
}
