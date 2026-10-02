import { memo } from "react";
import { useOrders } from "./useOrders";

interface OrderListProps {
  limit: number;
  emptyLabel?: string;
}

export const OrderList = memo(function OrderList({ limit }: OrderListProps) {
  const { orders } = useOrders();
  return <ul>{orders.slice(0, limit).map((order) => <li key={order.id}>{order.total}</li>)}</ul>;
});
