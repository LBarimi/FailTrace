// Authored lost-update fixture: read and write are separated by an async wait.
export function createCounter() {
  let value = 0;
  return {
    get value() { return value; },
    async increment(ready) {
      const previous = value;
      await ready;
      value = previous + 1;
    },
  };
}
