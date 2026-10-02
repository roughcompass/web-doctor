import { analytics } from "@enterprise/analytics";

export function cartViewed(itemCount) {
  analytics.track("commerce.cart.viewed", { cart: { itemCount } });
}
