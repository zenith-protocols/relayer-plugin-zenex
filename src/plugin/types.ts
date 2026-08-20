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

/**
 * Session-rule policy: the only `add_context_rule` / `remove_context_rule`
 * shape the relay will co-sign (see session.ts). Absent means session calls
 * are refused outright — never passed through unvalidated.
 */
export type SessionRulePolicy = {
  /** The session-policy contract every rule must install — exactly this one, nothing else. */
  policy: string;
  /** The verifier contract the rule's single External signer must ride through. */
  ed25519Verifier: string;
  /** The exact rule name the app registers. */
  ruleName: string;
  /** Upper bound on a rule's lifetime, in ledgers ahead of the live ledger. */
  maxDurationLedgers: number;
  /** Market capabilities a rule may encode: a Trading contract and its collateral token. */
  markets: readonly { trading: string; collateral: string }[];
};

// Submit-side policy: the configured Router at exact arity and the configured fee token.
// Inner calls pass through except session rules, which session.ts validates structurally —
// Soroban auth enforces everything else on-chain.
export type RelayParseConfig = {
  router: string;
  feeToken: { contractId: string; decimals: number; feeRateBps: number };
  session?: SessionRulePolicy;
};

export interface ParsedRelayCall {
  priced: boolean;
  user: string;
  feeRateBps: number;
  maximumFeeAtomic: bigint;
  feeExpiration: number;
  feedId: string | null;
  /**
   * Present when the batch installs session rules: their `valid_until` ledgers
   * and the configured window, checked against the live ledger after simulation.
   */
  sessionRules: { expiries: readonly number[]; maxDurationLedgers: number } | null;
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
