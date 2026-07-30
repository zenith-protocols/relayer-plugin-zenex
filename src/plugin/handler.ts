/**
 * handler.ts
 *
 * Main handler for the zenex plugin: dispatches the fee-abstraction routes and delegates to embedded channels.
 */

import { handler as channelsHandler } from '@openzeppelin/relayer-plugin-channels';
import { PluginContext, pluginError } from '@openzeppelin/relayer-sdk';
import type { Relayer } from '@openzeppelin/relayer-sdk';
import { loadConfig, relayParseConfig, ZenexConfig } from './config';
import { HTTP_STATUS, RELAYER_INFO_CACHE_TTL_SECONDS } from './constants';
import { parseSubmitRequest } from './parse';
import { prepareRelayEntries } from './prepare';
import { fetchMarketUpdate, fetchRelayPrices } from './pricing';
import { validateAndParsePrepareRequest, validateAndParseSubmitRequest } from './validation';
import { prepareFinalCall } from './submit';
import { RelayPrepareRoute } from './types';

/** Subset of relayer metadata used by the plugin (address + network_type). */
type CachedRelayerInfo = { address: string; network_type: string };
type CacheEntry = { info: CachedRelayerInfo; expiresAt: number };

/**
 * In-memory cache for relayer info. Avoids a remote API call (getRelayer → HTTP GET)
 * on every request. Keyed by `${network}:${relayerId}`.
 * Entries expire after RELAYER_INFO_CACHE_TTL_SECONDS; stale entries are evicted on miss.
 */
const relayerInfoCache = new Map<string, CacheEntry>();

/**
 * Return cached relayer info or fetch from the API and cache the result.
 * Returns null if the relayer has no address (misconfigured).
 */
async function getCachedRelayerInfo(
  network: string,
  relayerId: string,
  relayer: Relayer
): Promise<CachedRelayerInfo | null> {
  const cacheKey = `${network}:${relayerId}`;
  const cached = relayerInfoCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  // Evict stale entry so it doesn't linger in memory
  if (cached) relayerInfoCache.delete(cacheKey);

  const info = await relayer.getRelayer();
  if (!info?.address) return null;
  const entry: CachedRelayerInfo = { address: info.address, network_type: info.network_type };
  relayerInfoCache.set(cacheKey, { info: entry, expiresAt: Date.now() + RELAYER_INFO_CACHE_TTL_SECONDS * 1000 });
  return entry;
}

/** The fund relayer handle + address (the simulation source account). */
async function resolveFundRelayer(
  context: PluginContext,
  config: ZenexConfig
): Promise<{ relayer: Relayer; address: string }> {
  const relayer = context.api.useRelayer(config.fundRelayerId);
  const info = await getCachedRelayerInfo(config.network, config.fundRelayerId, relayer);
  if (!info) {
    throw pluginError('Fund relayer not found', {
      code: 'RELAYER_UNAVAILABLE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { relayerId: config.fundRelayerId },
    });
  }
  if (info.network_type !== 'stellar') {
    throw pluginError('Fund relayer network type must be stellar', {
      code: 'UNSUPPORTED_NETWORK',
      status: HTTP_STATUS.BAD_REQUEST,
      details: { network_type: info.network_type, relayerId: config.fundRelayerId },
    });
  }
  return { relayer, address: info.address };
}

async function handlePrepare(context: PluginContext, route: RelayPrepareRoute): Promise<unknown> {
  const request = validateAndParsePrepareRequest(context.params);
  const config = loadConfig(context);
  // Route policy: priced routes need the request's feedId to select the market price; `calls` ignores it.
  const priced = route !== 'calls';
  if (priced && request.feedId === undefined) {
    throw pluginError('Priced prepare requires a feedId to select its market price feed', {
      code: 'INVALID_PARAMS',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }
  const feedId = priced ? (request.feedId ?? null) : null;
  // Only the priced routes need a price (the request's market feed); an unpriced prepare never touches Pyth.
  const [market, fund] = await Promise.all([
    feedId === null ? null : fetchMarketUpdate(feedId, config.pythToken, config.pythChannel),
    resolveFundRelayer(context, config),
  ]);
  return prepareRelayEntries(
    route,
    request,
    relayParseConfig(config),
    config.networkPassphrase,
    fund.relayer,
    fund.address,
    market
  );
}

// One linear forward: parse, swap the relay-owned tail, simulate once, hand the signed call to the
// embedded channels handler (skipWait). Response and errors are channels' verbatim; the caller polls /status.
async function handleSubmit(context: PluginContext): Promise<unknown> {
  const request = validateAndParseSubmitRequest(context.params);
  const config = loadConfig(context);
  const parsed = parseSubmitRequest(request, relayParseConfig(config));
  const [prices, fund] = await Promise.all([
    fetchRelayPrices(parsed.feedId, config.pythToken, config.pythChannel),
    resolveFundRelayer(context, config),
  ]);
  const call = await prepareFinalCall(
    parsed,
    config.feeRecipient,
    prices,
    fund.address,
    fund.relayer,
    config.networkPassphrase
  );
  return channelsHandler({
    ...context,
    params: {
      func: call.func.toXDR('base64'),
      auth: call.auth.map((entry) => entry.toXDR('base64')),
      skipWait: true,
    },
  });
}

/**
 * Main plugin handler function
 */
export async function handler(context: PluginContext): Promise<unknown> {
  // context.route is the wildcard tail of POST .../plugins/{id}/call{route}; a bare /call answers with the
  // embedded channels handler's whole native surface (same pool and sequence caches). Raw sponsorship is
  // unpoliced, so the edge must forward only /call/prepare/* and /call/submit publicly; status polling goes
  // through the core transactions API (GET /api/v1/relayers/{id}/transactions/{txId}), not the plugin.
  if (context.route === '' || context.route === '/') {
    return channelsHandler(context);
  }
  console.log(`[zenex] Flow: ${context.route}`);
  switch (context.route) {
    case '/prepare/calls':
      return handlePrepare(context, 'calls');
    case '/prepare/fill':
      return handlePrepare(context, 'fill');
    case '/prepare/try-fill':
      return handlePrepare(context, 'try-fill');
    case '/submit':
      return handleSubmit(context);
    default:
      throw pluginError('Route was not found', { code: 'NOT_FOUND', status: HTTP_STATUS.NOT_FOUND });
  }
}
