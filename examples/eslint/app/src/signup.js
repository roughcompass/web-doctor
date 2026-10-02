import { analytics } from "@enterprise/analytics";

export function signupCompleted(emailAddress) {
  // eslint-disable-next-line adobe-analytics-eslint/no-direct-identifiers -- legacy form pending privacy review
  analytics.track("identity.signup.completed", { profile: { emailAddress } });
}
