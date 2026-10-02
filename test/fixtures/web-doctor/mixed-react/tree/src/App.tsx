import { SaltProvider } from "@salt-ds/core";
import { OrdersProvider } from "./orders/OrdersContext";
import { OrderList } from "@/orders/OrderList";
import Header from "./Header.jsx";

export function App() {
  return (
    <SaltProvider>
      <OrdersProvider>
        <Header title="Orders" />
        <OrderList limit={10} />
      </OrdersProvider>
    </SaltProvider>
  );
}
