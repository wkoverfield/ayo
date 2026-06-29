/**
 * Custom notification-sound (WAV) validation for `PUT /v1/me/sound` uploads.
 * Lean, friends-tier: cap size + length, sniff the RIFF/WAVE header (no decoder
 * on Workers), and content-hash for cache-busting + integrity. See the spec.
 */

import type { ApiErrorCode } from "@ayo-dev/core";

const MAX_SOUND_BYTES = 1024 * 1024; // 1 MB
const MAX_SECONDS = 2.5;

export type WavCheck = { ok: true; hash: string } | { ok: false; code: ApiErrorCode; message: string };

/** Validate a raw WAV body and return its SHA-256 (hex), or a typed error. */
export async function validateWav(buf: ArrayBuffer): Promise<WavCheck> {
  if (buf.byteLength === 0) return { ok: false, code: "bad_request", message: "Empty sound." };
  if (buf.byteLength > MAX_SOUND_BYTES) return { ok: false, code: "payload_too_large", message: "Sound exceeds 1 MB." };

  // RIFF....WAVE magic (bytes 0-3 "RIFF", 8-11 "WAVE"). Big-endian compare.
  const v = new DataView(buf);
  const isWav =
    buf.byteLength > 44 && v.getUint32(0, false) === 0x52494646 && v.getUint32(8, false) === 0x57415645;
  if (!isWav) return { ok: false, code: "bad_request", message: "Not a valid WAV file." };

  // Bound duration from the fmt byteRate (offset 28, LE) without decoding.
  const byteRate = v.getUint32(28, true);
  if (byteRate > 0 && (buf.byteLength - 44) / byteRate > MAX_SECONDS) {
    return { ok: false, code: "payload_too_large", message: "Sound must be ~2 seconds or less." };
  }

  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { ok: true, hash };
}
