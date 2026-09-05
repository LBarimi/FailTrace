export function createCounter() {
  let value = 0;
  return {
    get value() { return value; },
    async increment(ready) {
      await ready;
      value += 1;
    },
  };
}
