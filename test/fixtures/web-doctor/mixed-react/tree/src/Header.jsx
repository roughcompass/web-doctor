import PropTypes from "prop-types";
import { useOrders } from "./orders/useOrders";

export default function Header(props) {
  const { orders } = useOrders();
  return <h1>{props.title} ({orders.length})</h1>;
}

Header.propTypes = {
  title: PropTypes.string.isRequired,
};
