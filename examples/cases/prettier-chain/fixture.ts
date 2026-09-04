// Surrounding application context authored for this FailTrace case.
// The significant blank line follows the chain pattern in Prettier #15435.
interface Checkout {
  account: string;
  total: number;
}

const checkout: Checkout = { account: "demo", total: 42 };
const receipt = { status: "pending", currency: "USD" };

Receipt.prepare(checkout)

.save()

export function describeReceipt() {
  return `${receipt.status}: ${checkout.total} ${receipt.currency}`;
}
