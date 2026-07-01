/**
 * URL-safe bearer tokens for public capabilities (handoff links, inbound
 * webhooks). CSPRNG-backed; base64url, no padding. 16 bytes = 128 bits, which
 * is unguessable — these tokens ARE the only secret protecting a public route.
 */

export function urlSafeToken(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
