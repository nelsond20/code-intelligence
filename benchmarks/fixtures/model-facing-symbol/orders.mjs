export function orderStatus(order) {
  if (order.cancelled) return "cancelled";
  if (order.paid) return "paid";
  return "pending";
}

export function statusLabel(order) {
  return `Status: ${orderStatus(order)}`;
}

export function canDispatch(order) {
  return orderStatus(order) === "paid";
}
