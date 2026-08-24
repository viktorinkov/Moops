//
//  CartViewModel.swift
//  Food Delivery
//
//  Created by Loic HACHEME on 27/10/2023.
//

import Foundation

class CartViewModel: BaseViewModel {
    private static let deliveryPreferenceKey = "checkout.deliveryPreference"

    @Published var savedFoods: [FoodEntity] = []
    @Published var deliveryPreference: DeliveryPreference {
        didSet {
            UserDefaults.standard.set(
                deliveryPreference.rawValue,
                forKey: Self.deliveryPreferenceKey
            )
        }
    }
    @Published var isOrderVerified = false
    @Published private(set) var verifiedDeliveryPreference: DeliveryPreference?
    private let useCase = CartUseCase()
    private let foodUsecase = FoodUseCase()
    @Published var providers: [Int64: String] = [:]
    
    
    var total: Double {
        var total = 0.0
        savedFoods.forEach { foodEntity in
            total += Double(foodEntity.quantity) * foodEntity.price
        }
        return total
    }

    var isCheckoutReady: Bool {
        !savedFoods.isEmpty && savedFoods.allSatisfy { providers[$0.restaurantId] != nil }
    }
    
    override init() {
        deliveryPreference = DeliveryPreference(
            rawValue: UserDefaults.standard.string(forKey: Self.deliveryPreferenceKey) ?? ""
        ) ?? .leaveAtDoor
        super.init()
        Task {
            try? await fetchSavedFoods()
        }
        
        Task {
            try? await fetchRestaurants()
        }
    }
    
    func addOrder() async throws {
        let submittedPreference = deliveryPreference
        do {
            await setBusy(value: true)
            var data: [String: Any] = [:]
            var foodData:[[String: Any]] = []
            savedFoods.forEach { foodEntity in
                foodData.append([
                    "id": Int(foodEntity.id),
                    "quantity": Int(foodEntity.quantity)
                ])
            }
            
            
            data = [
                "order_status":"process",
                "foods":foodData,
                "status":"published",
                "delivery_preference":submittedPreference.rawValue
            ]
            
            try await useCase.addOrder(with: data)
            await MainActor.run {
                BenchmarkVerificationStore.record(submittedPreference)
                verifiedDeliveryPreference = submittedPreference
                isOrderVerified = true
            }
            await setBusy(value: false)
        } catch let error {
            await setBusy(value: false)
            await setError(error: error)
            throw error
        }
    }
    
    
    func addQuantity(for foodId: Int64) throws {
        do {
            try useCase.increaseFoodQuantity(for: foodId)
            savedFoods = try useCase.getSavedFoods()
        } catch let error {
            print("An error occured: \(error)")
        }
    }
    
    func reduceQuantity(for foodId: Int64) throws {
        do {
            try useCase.removeFoodFromCart(foodId: foodId)
            savedFoods = try useCase.getSavedFoods()
        } catch let error {
            print("An error occured: \(error)")
        }
    }
    
    func fetchSavedFoods() async throws {
        do {
           try await MainActor.run(body: {
                savedFoods = try useCase.getSavedFoods()
            })
        } catch let error {
            print("Error: \(error)")
        }
    }
    
    
    func fetchRestaurants() async throws {
        do {
            let data = try await foodUsecase.fetchRestaurants()
            await MainActor.run(body: {
                data.forEach { restaurant in
                    providers[Int64(restaurant.id ?? 0)] = restaurant.name ?? ""
                }
            })
            
        } catch let error {
            print("Error: \(error)")
            throw error
        }
    }
    
}
