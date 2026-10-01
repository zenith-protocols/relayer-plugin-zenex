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

/** The prepare route, which selects the forwarder entry point, its Router target, and the return ABI. */
export type RelayPrepareRoute = 'calls' | 'fill' | 'try-fill';

/** What the user authorizes in every wrap: the Router batch, the user, and the fee terms. */
export type WrapPrefix = {
  calls: Call[];
  user: string;
  feeToken: string;
  maximumFeeAtomic: bigint;
  feeExpirationLedger: number;
};

/**
 * The relay-supplied unsigned part of a wrap: the fee, plus keeper and price inside a priced wrap's
 * `target_args`. The recipient is not in it — the user signs the configured one.
 */
export type WrapTail = {
  feeAmountAtomic: bigint;
  keeper?: string;
  priceUpdate?: Uint8Array;
};

// Submit-side policy: the configured forwarder at exact arity, wrapping the configured Router and paying
// the configured recipient in the configured fee token. Inner calls pass through untouched — the user pays
// the relay fee, and Soroban auth enforces what their signature grants on-chain.
export type RelayParseConfig = {
  router: string;
  forwarder: string;
  feeRecipient: string;
  feeToken: { contractId: string; decimals: number; feeRateBps: number };
};

export interface ParsedRelayCall {
  priced: boolean;
  user: string;
  feeRateBps: number;
  maximumFeeAtomic: bigint;
  feeExpiration: number;
  feedId: string | null;
  /** The client's round-tripped func; its relay-owned parts are overwritten before any use. */
  func: xdr.HostFunction;
  /** The signed entries, decoded once at parse and forwarded as-is. */
  auth: xdr.SorobanAuthorizationEntry[];
}

export interface RelayPrepareRequest {
  user: string;
  calls: readonly string[];
  expirationLedger: number;
  maxFeeAmountAtomic: string;
  /** Data Streams feed id (bytes32 hex); selects the market price on priced routes, ignored on `calls`. */
  feedId?: string;
}

/** A submit body after validation: the round-tripped func and signed entries, decoded. */
export interface RelaySubmitRequest {
  func: xdr.HostFunction;
  auth: xdr.SorobanAuthorizationEntry[];
  feedId?: string;
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
