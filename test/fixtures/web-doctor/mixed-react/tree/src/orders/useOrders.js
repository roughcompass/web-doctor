import { useContext } from "react";
import { OrdersContext } from "./OrdersContext";

export function useOrders() {
  return useContext(OrdersContext);
}
