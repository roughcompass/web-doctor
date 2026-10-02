import { analytics } from "@enterprise/analytics";

export function checkoutStarted() {
  analytics.track("Checkout Started", { cart: { itemCount: 3 } });
}
