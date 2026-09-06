/**
 * Base class for all plugin-related errors
 */
export abstract class PluginClientError extends Error {
  abstract readonly category: 'transport' | 'execution' | 'client';
}

/**
 * HTTP/Network transport failures
 *
 * Thrown when communication with the service fails:
 * - Network errors (connection refused, timeout, DNS failures)
 * - HTTP errors (500, 502, 503, 504)
 * - Invalid responses (malformed JSON)
 */
export class PluginTransportError extends PluginClientError {
  readonly category = 'transport';

  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly errorDetails?: any // eslint-disable-line @typescript-eslint/no-explicit-any
  ) {
    super(message);
    this.name = 'PluginTransportError';
  }
}

/**
 * Plugin execution/validation errors
 *
 * Thrown when the plugin processes the request but returns an error:
 * - Validation failures (invalid parameters, missing auth)
 * - Business logic errors (fee above signed maximum, price unavailable)
 * - On-chain failures (simulation or transaction reverted)
 */
export class PluginExecutionError extends PluginClientError {
  readonly category = 'execution';

  constructor(
    message: string,
    public readonly errorDetails?: any // eslint-disable-line @typescript-eslint/no-explicit-any
  ) {
    super(message);
    this.name = 'PluginExecutionError';
  }
}

/**
 * Client-side parsing/validation errors
 *
 * Thrown when the client encounters unexpected issues:
 * - Empty or malformed responses
 * - Missing required fields in response
 * - Unexpected response structure
 */
export class PluginUnexpectedError extends PluginClientError {
  readonly category = 'client';

  constructor(
    message: string,
    public readonly errorDetails?: any // eslint-disable-line @typescript-eslint/no-explicit-any
  ) {
    super(message);
    this.name = 'PluginUnexpectedError';
  }
}

/**
 * Diagnostics that name a Soroban resource-limit failure.
 * The byte and instruction diagnostics arrive as "... resources exceeds amount
 * specified". The operation result arrives as `ResourceLimitExceeded`, spelled
 * with or without separators. The `txSorobanInvalid` transaction result code
 * alone does not qualify: it also carries an invalid footprint and an
 * insufficient resource fee, which no retry clears.
 */
const RESOURCE_LIMIT_PATTERNS = [/exceeds amount specified/i, /resource[_\s-]?limit[_\s-]?exceeded/i];

/** The message and any attached detail of a failure, flattened for pattern matching. */
function failureText(failure: unknown): string {
  if (typeof failure === 'string') return failure;
  if (failure === null || typeof failure !== 'object') return '';
  const message = failure instanceof Error ? failure.message : '';
  const seen = new WeakSet<object>();
  let body: string;
  try {
    body =
      JSON.stringify(failure, (_key, value: unknown) => {
        if (typeof value !== 'object' || value === null) return value;
        if (seen.has(value)) return undefined;
        seen.add(value);
        return value;
      }) ?? '';
  } catch {
    body = '';
  }
  return `${message} ${body}`;
}

/**
 * True when a relay failure names a resource limit, which one more attempt can clear.
 *
 * A transaction declares the resources its simulation measured. Another
 * transaction that touches the same position row or the market singleton grows
 * the write set before this one executes, and the ledger then rejects the
 * declared amount. A fresh simulation measures the larger write set, so retry.
 *
 * The failure must carry a resource-specific diagnostic. Every other failure is
 * terminal, including a `txSorobanInvalid` that names no resource.
 *
 * Accepts a thrown error, a plugin error body, or a status reason string.
 */
export function isResourceLimitFailure(failure: unknown): boolean {
  const text = failureText(failure);
  return text.trim() !== '' && RESOURCE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}
