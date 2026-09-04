export function checkout(values) {
  return { duplicateWorkAccepted: values.includes('BUG') };
}
