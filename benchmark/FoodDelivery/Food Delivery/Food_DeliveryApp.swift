//
//  Food_DeliveryApp.swift
//  Food Delivery
//
//  Created by Loic HACHEME on 11/09/2023.
//

import SwiftUI
import NavigationBackport
import Combine



@main
struct Food_DeliveryApp: App {
    @State var path = NBNavigationPath()
    private let benchmarkRun = BenchmarkRunContext.current
    private let showLastVerification = ProcessInfo.processInfo.environment[
        "MOOPS_SHOW_LAST_VERIFICATION"
    ] == "1"

    init() {
#if DEBUG
        if ProcessInfo.processInfo.environment["MOOPS_ENABLE_INJECTIONIII"] == "1" {
            Bundle(path: "/Applications/InjectionIII.app/Contents/Resources/iOSInjection.bundle")?.load()
        }
#endif
    }
    
    
    var body: some Scene {
        WindowGroup {
            
            VStack(spacing: 0) {
                if let benchmarkRun {
                    BenchmarkHUDView(context: benchmarkRun)
                        .padding(.vertical, 4)
                }

                if showLastVerification,
                   let benchmarkRun,
                   let preference = BenchmarkVerificationStore.preference(for: benchmarkRun) {
                    BenchmarkVerifiedView(deliveryPreference: preference)
                } else {
                    NBNavigationStack(path: $path) {
                        IntroView()
                        
                            .nbNavigationDestination(for: Destination.self) { destination in
                                switch destination {
                                case .start:
                                    StartView()
                                case .login:
                                    LoginView()
                                case .register:
                                    RegisterView()
                                case .bio:
                                    BioView()
                                case .payment(let fromLogin):
                                    PaymentMethodView(fromLogin: fromLogin)
                                case .addCreditCard:
                                    AddCreditCardView()
                                case .uploadPhoto:
                                    UploadPhotoView()
                                case .location:
                                    LocationView()
                                case .home:
                                        MainView()
                                case .notifications:
                                    NotificationsView()
                                case .orderDetails(let order):
                                    OrderDetailsView(with: order)
                                case .deliverAddress:
                                    DeliveryView()
                                case .restaurantDetails(let restaurant):
                                    RestaurantDetailsView(restaurant: restaurant)
                                case .testimonials(let restaurantId):
                                    TestimonialsView(restaurant: restaurantId)
                                case .favorites:
                                    FavoritesView()
                                case .popularMenu(let restaurantId):
                                    PopularMenuView(restaurantId: restaurantId)
                                case .forgotPassword:
                                    ForgotPasswordView()
                               
                                case .resendPassword:
                                    ResendPasswordView()
                                case .congratsForgotPassword:
                                    CongratsForgotPasswordView()
                                case .cart:
                                    CartView()
                                
                            }
                    }
                }
                }
            }
            
        }
    }
}
