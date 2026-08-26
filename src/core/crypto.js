'use strict';
/**
 * Crypto helpers. Rules:
 *  - Every random value is from crypto.randomBytes (never Math.random).
 *  - Nothing reusable is stored in plaintext: device tokens and pairing codes
 *    are persisted only as SHA-256 hashes.
 *  - Token comparison is constant-time.
 */
const crypto = require('node:crypto');

/** URL-safe random string with >=128 bits of entropy. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Request IDs are random, not sequential — they must not be guessable. */
function newRequestId() {
  return 'req_' + crypto.randomBytes(16).toString('hex');
}

function newDeviceId() {
  return 'dev_' + crypto.randomBytes(8).toString('hex');
}

/** Short, human-typeable pairing code. Ambiguous characters removed. */
function newPairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 3) out += '-';
  }
  return out;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Constant-time string compare that does not leak length via early return. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) {
    // Still burn a comparison so timing does not distinguish "wrong length"
    // from "wrong value".
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * A decision nonce binds one decision to exactly one request.
 * The phone receives the nonce with the request; the gateway accepts it once.
 */
function newDecisionNonce() {
  return crypto.randomBytes(24).toString('base64url');
}

module.exports = {
  randomToken,
  newRequestId,
  newDeviceId,
  newPairingCode,
  sha256,
  safeEqual,
  newDecisionNonce,
};
