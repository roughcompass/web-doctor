import { createContext, useState, type ReactNode } from "react";

export interface Order {
  id: string;
  total: number;
}

export const OrdersContext = createContext<{ orders: Order[] }>({ orders: [] });

export function OrdersProvider({ children }: { children: ReactNode }) {
  const [orders] = useState<Order[]>([]);
  return <OrdersContext.Provider value={{ orders }}>{children}</OrdersContext.Provider>;
}
