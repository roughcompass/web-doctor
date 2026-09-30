import { analytics } from "@enterprise/analytics";

analytics.track("commerce.checkout.started", {
  cart: {
    itemCount: 3,
    value: 149.5,
  },
  experience: {
    surface: "checkout",
  },
});