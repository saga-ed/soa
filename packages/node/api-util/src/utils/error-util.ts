export function ensureError(value: unknown): Error {
  if (value instanceof Error) return value;

  let stringified: string;
  try {
    stringified = JSON.stringify(value);
  } catch {
    stringified = '[Unable to stringify the thrown value]';
  }

  const error = new Error(`This value was thrown as is, not through an Error: ${stringified}`);
  return error;
}