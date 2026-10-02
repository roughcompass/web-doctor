import alloy from "@adobe/alloy";

export function recordPurchase(value) {
  alloy("sendEvent", { xdm: { commerce: { purchases: { value } } } });
}
