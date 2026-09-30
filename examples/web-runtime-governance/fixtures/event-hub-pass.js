import { runtimeApi } from "@enterprise/runtime-api";

runtimeApi.eventHub.publish("orders.updated", {
  orderId: "order-123",
});