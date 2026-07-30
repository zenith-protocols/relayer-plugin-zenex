/**
 * types.ts
 *
 * Type definitions for the zenex relay plugin.
 */

import { xdr } from '@stellar/stellar-sdk';

/** One Router batch call: target contract, entry-point name, host-encoded positional args. */
export interface Call {
  contract: string;
  func: string;
  args: xdr.ScVal[];
}

/** The prepare route, which selects the Router wrap and its return ABI. */
export type RelayPrepareRoute = 'calls' | 'fill' | 'try-fill';

/** The prefix of every Router `*_with_fee` wrap — what the user authorizes. */
export type RouterWrapPrefix = {
  calls: Call[];
  user: string;
  feeToken: string;
  maximumFeeAtomic: bigint;
  feeExpirationLedger: number;
};

/** The relay-supplied unsigned tail; keeper+price extend it on priced wraps. */
export type RouterWrapTail = {
  feeAmountAtomic: bigint;
  feeRecipient: string;
  keeper?: string;
  priceUpdate?: Uint8Array;
};

// Submit-side policy: the configured Router at exact arity and the configured fee token.
// No inner-call allowlist — Soroban auth enforces on-chain.
export type RelayParseConfig = {
  router: string;
  feeToken: { contractId: string; decimals: number; feeRateBps: number };
};

export interface ParsedRelayCall {
  priced: boolean;
  user: string;
  feeRateBps: number;
  maximumFeeAtomic: bigint;
  feeExpiration: number;
  feedId: number | null;
  /** The client's round-tripped func; its tail is overwritten before any use. */
  func: xdr.HostFunction;
  /** The signed entries, decoded once at parse and forwarded as-is. */
  auth: xdr.SorobanAuthorizationEntry[];
}

export interface RelayPrepareRequest {
  user: string;
  calls: readonly string[];
  expirationLedger: number;
  maxFeeAmountAtomic: string;
  /** Selects the market price on priced routes; ignored on `calls`. */
  feedId?: number;
}

/** A submit body after validation: the round-tripped func and signed entries, decoded. */
export interface RelaySubmitRequest {
  func: xdr.HostFunction;
  auth: xdr.SorobanAuthorizationEntry[];
  feedId?: number;
}

export interface RelayPreparedAuthEntry {
  xdr: string;
  payloadHash: string;
  signer: string;
  signatureExpirationLedger: number;
}

export interface RelayPrepareOutcome {
  kind: 'fills' | 'rests' | 'callOutcomes';
  results: readonly unknown[];
}

export interface RelayPrepareResult {
  func: string;
  authEntries: RelayPreparedAuthEntry[];
  outcome: RelayPrepareOutcome;
  feeTerms: { token: string; decimals: number; maximumAmount: string; expirationLedger: number };
}
