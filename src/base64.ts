/** Validate standard padded base64 without recursive regular-expression groups. */
export function isBase64String(value: unknown): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding));
}
