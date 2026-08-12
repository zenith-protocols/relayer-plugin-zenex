/**
 * validation.ts
 *
 * Request validation and parsing for the zenex plugin. Mirrors the channels
 * plugin's convention: strict per-route bodies — unknown keys are rejected,
 * every field is type- and range-checked, and decode failures map to
 * INVALID_PARAMS before any of the value reaches the pipeline.
 */

import { StrKey, xdr } from '@stellar/stellar-sdk';
import { FEED_ID_PATTERN } from './config';
import { invalidParams } from './parse';
import { RelayPrepareRequest, RelaySubmitRequest } from './types';

/** Soroban ledger sequences (and so fee expirations) are u32s. */
const MAX_U32 = 0xffffffff;
/** Non-negative decimal integer — exactly what `BigInt()` accepts without throwing. */
const DECIMAL_AMOUNT = /^\d+$/;

const PREPARE_KEYS = ['user', 'calls', 'expirationLedger', 'maxFeeAmountAtomic', 'feedId'];
const SUBMIT_KEYS = ['func', 'auth', 'feedId'];

function requestBody(params: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    invalidParams('Relay request body must be an object');
  }
  const body = params as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    invalidParams('Relay request must not include unknown parameters', { unknown });
  }
  return body;
}

// Normalized to lowercase to match the config's feed id, so downstream comparisons are plain equality.
function validateFeedId(feedId: unknown): string | undefined {
  if (feedId === undefined) return undefined;
  if (typeof feedId !== 'string' || !FEED_ID_PATTERN.test(feedId)) {
    invalidParams('`feedId` must be a 0x-prefixed 32-byte hex string');
  }
  return feedId.toLowerCase();
}

// One shared body for the three prepare routes; the route selects the wrap.
// `feedId` selects the market price on priced routes, ignored on `calls`.
export function validateAndParsePrepareRequest(params: unknown): RelayPrepareRequest {
  const request = requestBody(params, PREPARE_KEYS);
  if (
    typeof request.user !== 'string' ||
    !(StrKey.isValidEd25519PublicKey(request.user) || StrKey.isValidContract(request.user))
  ) {
    invalidParams('`user` must be a Stellar account or contract address');
  }
  if (
    !Array.isArray(request.calls) ||
    request.calls.length === 0 ||
    !request.calls.every((call): call is string => typeof call === 'string' && call !== '')
  ) {
    invalidParams('`calls` must be a non-empty array of base64 strings');
  }
  if (
    typeof request.expirationLedger !== 'number' ||
    !Number.isSafeInteger(request.expirationLedger) ||
    request.expirationLedger < 0 ||
    request.expirationLedger > MAX_U32
  ) {
    invalidParams('`expirationLedger` must be a u32 ledger sequence');
  }
  if (typeof request.maxFeeAmountAtomic !== 'string' || !DECIMAL_AMOUNT.test(request.maxFeeAmountAtomic)) {
    invalidParams('`maxFeeAmountAtomic` must be a non-negative integer string');
  }
  return {
    user: request.user,
    calls: request.calls,
    expirationLedger: request.expirationLedger,
    maxFeeAmountAtomic: request.maxFeeAmountAtomic,
    feedId: validateFeedId(request.feedId),
  };
}

// Submit round-trips the prepared func alongside the signed entries, decoded here (decode is the
// validation). `feedId` is required iff the func is priced — that gate lives in parse, off the func itself.
export function validateAndParseSubmitRequest(params: unknown): RelaySubmitRequest {
  const request = requestBody(params, SUBMIT_KEYS);
  if (typeof request.func !== 'string' || request.func === '') {
    invalidParams('`func` must be a non-empty base64 string');
  }
  if (
    !Array.isArray(request.auth) ||
    request.auth.length === 0 ||
    !request.auth.every((entry): entry is string => typeof entry === 'string' && entry !== '')
  ) {
    invalidParams('`auth` must be a non-empty array of base64 strings');
  }
  const feedId = validateFeedId(request.feedId);

  let func: xdr.HostFunction;
  let auth: xdr.SorobanAuthorizationEntry[];
  try {
    func = xdr.HostFunction.fromXDR(request.func, 'base64');
    auth = request.auth.map((entry) => xdr.SorobanAuthorizationEntry.fromXDR(entry, 'base64'));
  } catch (e) {
    return invalidParams('Invalid `func` or `auth` encoding', {
      message: e instanceof Error ? e.message : String(e),
    });
  }

  return { func, auth, feedId };
}
