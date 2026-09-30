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

/**
 * The request fields every wrap carries: the Router `*_with_fee` prefix the user authorizes, and in
 * forwarder mode the fee terms, user, and Router batch of the forwarder wrap.
 */
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

/**
 * The relay-supplied unsigned part of a forwarder wrap: the fee, plus keeper+price inside a priced
 * wrap's `target_args`. The recipient is not in it — the user signs the forwarder's recipient.
 */
export type ForwarderWrapTail = Omit<RouterWrapTail, 'feeRecipient'>;

/** Forwarder mode: the fee forwarder every relayed func targets, and the recipient its users sign. */
export type ForwarderPolicy = {
  contract: string;
  feeRecipient: string;
};

/** Router mode wraps the calls in a Router `*_with_fee`; forwarder mode in the fee forwarder's `forward*`. */
export type RelayMode = 'router' | 'forwarder';

// Submit-side policy: the configured Router (or forwarder) at exact arity and the configured fee token.
// Inner calls pass through untouched — the user pays the relay fee, and Soroban
// auth enforces what their signature grants on-chain.
export type RelayParseConfig = {
  router: string;
  /** Present selects forwarder mode; absent keeps the Router `*_with_fee` mode. */
  forwarder?: ForwarderPolicy;
  feeToken: { contractId: string; decimals: number; feeRateBps: number };
};

export interface ParsedRelayCall {
  mode: RelayMode;
  priced: boolean;
  user: string;
  feeRateBps: number;
  maximumFeeAtomic: bigint;
  feeExpiration: number;
  feedId: string | null;
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
