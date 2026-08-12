import type { LogEntry } from '@openzeppelin/relayer-sdk';

/**
 * Configuration for ZenexClient in direct HTTP mode (an edge worker in front
 * of the relayer that forwards `/prepare/*` and `/submit` and serves `/status`)
 */
export interface DirectHttpConfig {
  /** Base URL of the edge service in front of the relayer */
  baseUrl: string;
  /** Optional API key, sent as a Bearer token when provided */
  apiKey?: string;
  /** Optional request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Configuration for ZenexClient in relayer mode
 */
export interface RelayerConfig {
  /** Plugin ID in the OpenZeppelin Relayer (e.g. 'zenex') */
  pluginId: string;
  /** API key for the OpenZeppelin Relayer */
  apiKey: string;
  /** Base URL for the OpenZeppelin Relayer */
  baseUrl: string;
  /** Optional request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Header name for API key forwarding to plugin (default: 'x-api-key') */
  apiKeyHeader?: string;
}

/**
 * Configuration for ZenexClient
 * The client automatically detects the mode:
 * - If pluginId is provided → relayer mode
 * - Otherwise → direct HTTP mode
 */
export type ZenexClientConfig = DirectHttpConfig | RelayerConfig;

/**
 * Shared body for the three prepare routes
 */
export interface ZenexPrepareRequest {
  /** The user's Stellar account (G...) or contract (C...) address */
  user: string;
  /** Router `Call` ScVals, base64-encoded */
  calls: string[];
  /** Ledger sequence the signed authorization expires at */
  expirationLedger: number;
  /** Signed fee cap in the fee token's atomic units, as a decimal string */
  maxFeeAmountAtomic: string;
  /** Chainlink Data Streams feed id (bytes32 hex) for the market price; required on priced routes, ignored on `calls` */
  feedId?: string;
}

/**
 * Prepare request for the priced routes (`fill`, `try-fill`): `feedId` is required
 */
export type ZenexPricedPrepareRequest = ZenexPrepareRequest & { feedId: string };

/**
 * One prepared authorization entry for the user to sign (SEP-43 compatible)
 */
export interface ZenexPreparedAuthEntry {
  /** The SorobanAuthorizationEntry XDR, base64-encoded */
  xdr: string;
  /** Hex sha256 of the SorobanAuthorization preimage the wallet signs */
  payloadHash: string;
  /** The address whose signature is required (always the request's user) */
  signer: string;
  /** The stamped signature expiration ledger */
  signatureExpirationLedger: number;
}

/**
 * Decoded discovery-simulation outcome for the prepared invocation
 */
export interface ZenexPrepareOutcome {
  kind: 'fills' | 'rests' | 'callOutcomes';
  results: unknown[];
}

/**
 * Response from the prepare routes
 */
export interface ZenexPrepareResponse {
  /** The prepared Router HostFunction XDR, base64-encoded; round-trip it to submit */
  func: string;
  /** Authorization entries the user must sign */
  authEntries: ZenexPreparedAuthEntry[];
  /** Decoded simulation outcome */
  outcome: ZenexPrepareOutcome;
  /** The fee terms the user signs over */
  feeTerms: {
    token: string;
    decimals: number;
    maximumAmount: string;
    expirationLedger: number;
  };
  /** Optional metadata (logs and traces) */
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Submit request: the prepared func round-tripped with the signed entries
 */
export interface ZenexSubmitRequest {
  /** The prepared HostFunction XDR from a prepare response, base64-encoded */
  func: string;
  /** The signed authorization entry XDRs, base64-encoded */
  auth: string[];
  /** Chainlink Data Streams feed id (bytes32 hex) for the market price; required when the func is priced */
  feedId?: string;
}

/**
 * Request to get a transaction by ID
 */
export interface ZenexGetTransactionRequest {
  /** Transaction ID returned from a previous submission */
  transactionId: string;
}

/**
 * Response from transaction submission and status polling
 * (the embedded channels handler's response, verbatim)
 */
export interface ZenexTransactionResponse {
  /** Transaction ID from the relayer */
  transactionId: string | null;
  /** Transaction hash on-chain (usually still null right after submission) */
  hash: string | null;
  /** Transaction status */
  status: string | null;
  /** Optional metadata (logs and traces) */
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Plugin response structure for successful operations
 */
export interface PluginResponseSuccess<T> {
  success: true;
  data: T;
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Plugin response structure for failed operations
 */
export interface PluginResponseError {
  success: false;
  error: string;
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  metadata?: {
    logs?: LogEntry[];
    traces?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/**
 * Discriminated union type for all plugin responses
 * Enables type-safe handling of success/error cases
 */
export type PluginResponse<T> = PluginResponseSuccess<T> | PluginResponseError;
