# Fixed benchmark feature prompt

You are modifying the supplied FoodDelivery iOS application.

Add a saved delivery preference to the real checkout flow.

Requirements:

1. Add a new Swift source/domain type named `DeliveryPreference` with exactly
   two user-visible choices: `Leave at door` and `Meet at door`.
2. Add stored checkout/view-model state for the selected preference. The default
   is `Leave at door`.
3. Show an accessible control on the real cart/checkout screen and give it the
   accessibility identifier `checkout.deliveryPreference`.
4. Persist the selection in the application so it remains selected after a
   terminate-and-relaunch cycle for the same installed app.
5. Extend the existing `Order` domain model to decode `delivery_preference`, and
   submit the selected raw value to the real local HTTP backend under that JSON
   field when the user places the order.
6. Keep the existing authenticated session, Core Data cart, backend-derived
   catalog/prices, navigation, and order behavior working.

Do not replace the runtime flow with mock data, a Preview-only implementation,
a deep-link that bypasses checkout, or test-only production behavior.

The task passes only when the shared UI acceptance path proves the control can
change, survives relaunch, and the backend receives the selected value.
