/**
 * Zenex Plugin Client
 *
 * Unified client for interacting with the zenex plugin
 * in both direct HTTP mode and OpenZeppelin Relayer mode.
 */

export { ZenexClient } from './zenex-client';
export {
  ZenexClientConfig,
  DirectHttpConfig,
  RelayerConfig,
  ZenexPrepareRequest,
  ZenexPricedPrepareRequest,
  ZenexPreparedAuthEntry,
  ZenexPrepareOutcome,
  ZenexPrepareResponse,
  ZenexSubmitRequest,
  ZenexGetTransactionRequest,
  ZenexTransactionResponse,
} from './types';
export {
  PluginClientError,
  PluginTransportError,
  PluginExecutionError,
  PluginUnexpectedError,
  isResourceLimitFailure,
} from './errors';
