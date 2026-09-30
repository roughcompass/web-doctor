import { analytics } from "@enterprise/analytics";

analytics.track("identity.signup.completed", {
  profile: {
    emailAddress: "person@example.test",
  },
});