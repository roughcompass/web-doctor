import { analytics } from "@enterprise/analytics";

analytics.track("Checkout Started", {
  cart: { itemCount: 3 },
});