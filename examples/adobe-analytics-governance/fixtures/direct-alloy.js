import alloy from "@adobe/alloy";

alloy("sendEvent", {
  type: "commerce.purchases",
  xdm: {
    commerce: {
      purchases: { value: 1 },
    },
  },
});