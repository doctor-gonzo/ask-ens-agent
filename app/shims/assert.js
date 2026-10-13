// Browser stand-in for Node's `assert`, which the Reclaim SDK calls as a function.
export default function assert(value, message) {
  if (!value) throw new Error(message ?? 'Assertion failed');
}
