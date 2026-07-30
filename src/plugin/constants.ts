/**
 * constants.ts
 *
 * Centralized constants for the zenex plugin.
 */

// HTTP Status Codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  UNPROCESSABLE_ENTITY: 422,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

// Pyth Lazer access
export const PYTH = {
  LATEST_PRICE_URL: 'https://pyth-lazer-0.dourolabs.app/v1/latest_price',
  FETCH_TIMEOUT_MS: 5_000,
  XLM_USD_FEED_ID: 23,
  // Every property the on-chain price verifier requires in the signed payload; it rejects (error 781) a payload missing any.
  LATEST_PRICE_PROPERTIES: ['price', 'bestBidPrice', 'bestAskPrice', 'exponent', 'confidence', 'feedUpdateTimestamp'],
} as const;

// Simulation-related defaults
export const SIMULATION = {
  DEFAULT_FEE: '100',
} as const;

// Time constants — used for simulation tx construction
export const TIME = {
  MIN_TIME_BOUND: 0,
  MAX_TIME_BOUND_OFFSET_SECONDS: 60,
} as const;

// Relayer info cache — address and network_type are effectively immutable
export const RELAYER_INFO_CACHE_TTL_SECONDS = 1_800; // 30 minutes

export const RELAY = {
  /** Minimum ledgers between a simulation's own ledger and a signed expiration: clears channels' 2-ledger buffer plus inclusion latency. */
  MIN_EXPIRATION_BUFFER_LEDGERS: 3,
} as const;
