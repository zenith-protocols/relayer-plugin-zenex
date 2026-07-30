import axios, { AxiosInstance } from 'axios';
import { Configuration, PluginsApi } from '@openzeppelin/relayer-sdk';
import type { LogEntry } from '@openzeppelin/relayer-sdk';
import { PluginTransportError, PluginExecutionError, PluginUnexpectedError } from './errors';
import type {
  ZenexClientConfig,
  ZenexPrepareRequest,
  ZenexPricedPrepareRequest,
  ZenexPrepareResponse,
  ZenexSubmitRequest,
  ZenexGetTransactionRequest,
  ZenexTransactionResponse,
  PluginResponse,
} from './types';

/** The plugin's route tails; direct HTTP mode posts to the same paths on the edge service. */
const ROUTES = {
  prepareCalls: '/prepare/calls',
  prepareFill: '/prepare/fill',
  prepareTryFill: '/prepare/try-fill',
  submit: '/submit',
  /** Direct mode only: the edge service's own status endpoint. */
  status: '/status',
  /** Relayer mode only: the bare route answers the embedded channels surface (getTransaction). */
  bare: '',
} as const;

/**
 * Client for interacting with the zenex plugin
 *
 * @example
 * // Connecting through the public edge service (direct HTTP mode)
 * const client = new ZenexClient({
 *   baseUrl: 'https://relay.example.com',
 * });
 *
 * @example
 * // Connecting to your own Relayer with the zenex plugin (relayer mode)
 * const client = new ZenexClient({
 *   baseUrl: 'http://localhost:8080',
 *   pluginId: 'zenex',
 *   apiKey: 'your-relayer-api-key',
 * });
 */
export class ZenexClient {
  private readonly axiosClient?: AxiosInstance;
  private readonly pluginsApi?: PluginsApi;
  private readonly pluginId?: string;

  constructor(config: ZenexClientConfig) {
    // Route through Relayer plugin system if pluginId provided, otherwise connect directly
    if ('pluginId' in config && config.pluginId) {
      this.pluginId = config.pluginId;
      const apiKeyHeader = config.apiKeyHeader || 'x-api-key';

      const relayerConfig = new Configuration({
        basePath: config.baseUrl,
        accessToken: config.apiKey,
        baseOptions: {
          headers: { [apiKeyHeader]: config.apiKey },
          timeout: config.timeout || 30000,
        },
      });

      this.pluginsApi = new PluginsApi(relayerConfig);
    } else {
      if (!('baseUrl' in config) || !config.baseUrl) {
        throw new Error('baseUrl is required when pluginId is not provided');
      }

      this.axiosClient = axios.create({
        baseURL: config.baseUrl,
        timeout: config.timeout || 30000,
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
      });
    }
  }

  /**
   * Prepare an unpriced multicall (`multicall_with_fee`)
   *
   * @param request Prepare request with the user, calls, expiration, and fee cap
   * @returns The prepared func, auth entries to sign, and the decoded simulation outcome
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   *
   * @example
   * const prepared = await client.prepareCalls({
   *   user: 'G...',
   *   calls: ['AAAA...'],
   *   expirationLedger: 123456,
   *   maxFeeAmountAtomic: '1000000',
   * });
   */
  async prepareCalls(request: ZenexPrepareRequest): Promise<ZenexPrepareResponse> {
    return this.call<ZenexPrepareResponse>(ROUTES.prepareCalls, request);
  }

  /**
   * Prepare a priced fill (`create_and_fill_with_fee`); `feedId` is required
   *
   * @param request Prepare request; `calls[0]` must be `create_order`
   * @returns The prepared func, auth entries to sign, and the decoded fill outcome
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   */
  async prepareFill(request: ZenexPricedPrepareRequest): Promise<ZenexPrepareResponse> {
    return this.call<ZenexPrepareResponse>(ROUTES.prepareFill, request);
  }

  /**
   * Prepare a priced try-fill (`create_and_try_fill_with_fee`); `feedId` is required
   *
   * @param request Prepare request with the user, calls, expiration, and fee cap
   * @returns The prepared func, auth entries to sign, and the decoded outcome
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   */
  async prepareTryFill(request: ZenexPricedPrepareRequest): Promise<ZenexPrepareResponse> {
    return this.call<ZenexPrepareResponse>(ROUTES.prepareTryFill, request);
  }

  /**
   * Submit a prepared func with the user-signed authorization entries
   *
   * @param request The round-tripped func and signed auth entries
   * @returns Channels' response verbatim: `{transactionId, status, hash}` with `hash` usually still null
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   *
   * @example
   * const result = await client.submit({ func: prepared.func, auth: signedEntries });
   * // poll getTransaction(result.transactionId) until hash is set
   */
  async submit(request: ZenexSubmitRequest): Promise<ZenexTransactionResponse> {
    return this.call<ZenexTransactionResponse>(ROUTES.submit, request);
  }

  /**
   * Get a transaction by ID, typically used to poll after submission
   *
   * In relayer mode this asks the embedded channels surface on the bare route;
   * in direct HTTP mode it asks the edge service's `/status` endpoint.
   *
   * @param request Request with transactionId
   * @returns Transaction result with ID, hash, and status
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   *
   * @example
   * const result = await client.getTransaction({ transactionId: 'tx-123' });
   * console.log(result.status); // 'confirmed', 'pending', etc.
   */
  async getTransaction(request: ZenexGetTransactionRequest): Promise<ZenexTransactionResponse> {
    if (this.pluginsApi) {
      return this.call<ZenexTransactionResponse>(ROUTES.bare, {
        getTransaction: { transactionId: request.transactionId },
      });
    }
    return this.call<ZenexTransactionResponse>(ROUTES.status, {
      transactionId: request.transactionId,
    });
  }

  /**
   * Parses axios errors and extracts response body if available
   *
   * @param error The caught error from axios
   * @returns Plugin response if available in error
   * @throws {PluginTransportError} For network/transport errors
   * @throws {PluginUnexpectedError} For unknown error types
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseAxiosError(error: unknown): PluginResponse<any> | never {
    if (axios.isAxiosError(error)) {
      if (error.response?.data) {
        // HTTP error with response body - return it for further processing
        return error.response.data;
      }
      // Network/transport error without response body. Details are sanitized:
      // the raw AxiosError carries the request config, including the API-key header.
      throw new PluginTransportError(`Network error: ${error.message}`, error.response?.status, {
        code: error.code,
        message: error.message,
        status: error.response?.status,
      });
    }
    // Unknown error type
    throw new PluginUnexpectedError(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { name: error.name, message: error.message } : error
    );
  }

  /**
   * Validates that response has the expected plugin response structure
   *
   * @param responseBody The raw response body to validate
   * @returns Validated plugin response
   * @throws {PluginUnexpectedError} For invalid/malformed responses
   */
  private validateResponse<T>(responseBody: unknown): PluginResponse<T> {
    if (!responseBody || typeof responseBody !== 'object') {
      throw new PluginUnexpectedError('Empty or invalid response from plugin');
    }

    const response = responseBody as PluginResponse<T>;

    if (response.success === undefined) {
      throw new PluginUnexpectedError('Malformed response: missing success field');
    }

    return response;
  }

  /**
   * Merges metadata into the response data if present
   *
   * @param data The response data
   * @param metadata Optional metadata (logs and traces)
   * @returns Data with metadata merged if present
   */
  private mergeMetadata<T>(
    data: T,
    metadata?: { logs?: LogEntry[]; traces?: any[] } // eslint-disable-line @typescript-eslint/no-explicit-any
  ): T {
    if (!metadata || (!metadata.logs && !metadata.traces)) {
      return data;
    }
    return { ...data, metadata } as T;
  }

  /**
   * Internal method to make a plugin call with automatic payload wrapping and response parsing
   *
   * @param route The plugin route tail (or edge path in direct HTTP mode)
   * @param params Request parameters
   * @returns Parsed response data with optional metadata
   * @throws {PluginTransportError} Network/HTTP failures
   * @throws {PluginExecutionError} Plugin rejected the request
   * @throws {PluginUnexpectedError} Malformed response or client-side errors
   */
  private async call<T>(route: string, params: unknown): Promise<T> {
    const payload = { params };

    // Send request and handle transport errors
    let responseBody: unknown;
    try {
      responseBody = await this.sendCall(route, payload);
    } catch (error) {
      responseBody = this.parseAxiosError(error);
    }

    // Validate response structure
    const response = this.validateResponse<T>(responseBody);

    // Handle execution errors
    if (!response.success) {
      const errorDetails = response.metadata ? { ...response.data, metadata: response.metadata } : response.data;
      throw new PluginExecutionError(response.error || 'Plugin execution failed', errorDetails);
    }

    // Return data with metadata if present
    return this.mergeMetadata(response.data, response.metadata);
  }

  /**
   * Internal method to send the actual HTTP request
   * Routes to either axios (direct HTTP) or PluginsApi (relayer) based on configuration
   *
   * @param route The plugin route tail (or edge path in direct HTTP mode)
   * @param payload The complete payload (already wrapped in {params})
   * @returns Raw response from the service/relayer
   */
  private async sendCall(route: string, payload: { params: unknown }): Promise<unknown> {
    if (this.pluginsApi) {
      const response = await this.pluginsApi.callPlugin(this.pluginId!, payload, route || undefined);
      return response.data;
    }

    const response = await this.axiosClient!.post(route || '/', payload);
    return response.data;
  }
}
