//
//  CartView.swift
//  Food Delivery
//
//  Created by Loic HACHEME on 27/10/2023.
//

import SwiftUI
import NavigationBackport

struct CartView: View {
    @StateObject private var vm = CartViewModel()
    @EnvironmentObject private var navigator: PathNavigator
    @State private var showAlert = false

    var body: some View {
        Group {
            if vm.isOrderVerified {
                BenchmarkVerifiedView(
                    deliveryPreference: vm.verifiedDeliveryPreference ?? vm.deliveryPreference
                )
            } else {
                checkout
            }
        }
        .navigationBarBackButtonHidden()
        .onError($vm.errorWrapper)
        .alert(isPresented: $showAlert) {
            Alert(
                title: Text("Order"),
                message: Text("Confirm this order ?"),
                primaryButton: .default(Text("Yes"), action: {
                    showAlert = false
                    Task {
                        do {
                            try await vm.addOrder()
                        } catch {
                            print("Error occured: \(error)")
                        }
                    }
                }),
                secondaryButton: .cancel(Text("No"))
            )
        }
    }

    private var checkout: some View {
        VStack {
            header

            if vm.isCheckoutReady {
                Text("Checkout ready")
                    .frame(width: 1, height: 1)
                    .opacity(0.01)
                    .accessibilityIdentifier("checkout.ready")
            }

            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 15) {
                    ForEach(vm.savedFoods) { savedFood in
                        FoodCartItemView(
                            food: savedFood,
                            provider: vm.providers[savedFood.restaurantId] ?? "..."
                        ) {
                            try? vm.addQuantity(for: savedFood.id)
                        } reduceQuantityCallable: {
                            try? vm.reduceQuantity(for: savedFood.id)
                        }
                    }
                }
                .padding(.horizontal)

                Spacer().frame(height: 20)

                deliveryPreferenceSelector

                Spacer().frame(height: 22)

                Text("Total: \(vm.total.asNumberString()) $")
                    .font(.custom("Satoshi-Bold", size: 17))
                    .accessibilityIdentifier("checkout.total")

                Spacer().frame(height: 30)

                Button {
                    showAlert.toggle()
                } label: {
                    if vm.isBusy {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .theme.fieldBackground))
                            .frame(width: 200)
                            .padding(.vertical, 20)
                            .background(Color.theme.accent)
                            .cornerRadius(16)
                    } else {
                        Text("Place my order")
                            .font(.custom("Satoshi-Bold", size: 16))
                            .foregroundColor(.white)
                            .padding(.horizontal, 50)
                            .padding(.vertical, 20)
                            .background(Color.theme.accent)
                            .cornerRadius(16)
                    }
                }
                .accessibilityIdentifier("checkout.placeOrder")
                .disabled(vm.isBusy)

                Spacer().frame(height: 30)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var deliveryPreferenceSelector: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Delivery preference")
                .font(.custom("Satoshi-Bold", size: 17))

            Picker("Delivery preference", selection: $vm.deliveryPreference) {
                ForEach(DeliveryPreference.allCases) { preference in
                    Text(preference.rawValue).tag(preference)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("checkout.deliveryPreference")
            .accessibilityValue(vm.deliveryPreference.rawValue)
            .disabled(vm.isBusy)
        }
        .padding(.horizontal)
    }
}

struct CartView_Previews: PreviewProvider {
    static var previews: some View {
        CartView()
    }
}

extension CartView {
    var header: some View {
        HStack {
            Rectangle()
                .foregroundColor(.clear)
                .frame(width: 52, height: 52)
                .background(Color.theme.cardBackgroundColor)
                .cornerRadius(16)
                .shadow(
                    color: Color(red: 0.05, green: 0.37, blue: 0.98).opacity(0.2),
                    radius: 10,
                    x: 0,
                    y: 7
                )
                .overlay(Image(systemName: "chevron.left"))
                .onTapGesture {
                    navigator.pop()
                }

            Spacer().frame(width: 40)

            Text("My cart")
                .font(.custom("Satoshi-Bold", size: 20))
                .accessibilityIdentifier("screen.cart")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
    }
}
