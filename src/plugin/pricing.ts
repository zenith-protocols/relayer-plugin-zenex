/**
 * pricing.ts
 *
 * Pyth Lazer prices for the relay: one signed price per HTTP request; integrity and freshness are enforced on-chain (errors 781/782).
 */

import { pluginError } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS, PYTH } from './constants';

/** One signed Pyth Lazer price: the number for off-chain fee math, the signed wire payload for on-chain use. */
type LazerPrice = { price: number; update: Uint8Array };

/** What one submit pass consumes: XLM/USD for fee conversion, the market payload for priced tails. */
export type RelayPrices = { xlmUsd: number; marketUpdate: Uint8Array | null };

// Structural cast target only — conversion trusts Pyth; any missing field throws, mapped wholesale to PRICE_UNAVAILABLE.
interface LazerLatestPriceBody {
  parsed: { priceFeeds: readonly { priceFeedId: number; price: number | string; exponent: number }[] };
  leEcdsa: { data: string };
}

/** A dropped socket or upstream hiccup is worth one more attempt; a 4xx is not. */
async function latestPriceResponse(feedId: number, token: string, channel: string): Promise<Response> {
  const request = (): Promise<Response> =>
    fetch(PYTH.LATEST_PRICE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        priceFeedIds: [feedId],
        properties: PYTH.LATEST_PRICE_PROPERTIES,
        formats: ['leEcdsa'],
        jsonBinaryEncoding: 'base64',
        parsed: true,
        channel,
      }),
      signal: AbortSignal.timeout(PYTH.FETCH_TIMEOUT_MS),
    });
  try {
    const response = await request();
    if (response.status < 500) return response;
  } catch {
    // Network-level failure: idle keep-alive sockets die between sporadic
    // requests, so the first reuse after a quiet spell can fail spuriously.
  }
  await new Promise((resolve) => setTimeout(resolve, PYTH.RETRY_DELAY_MS));
  return request();
}

/** One feed per request — the on-chain verifier expects single-feed leEcdsa payloads; any failure is PRICE_UNAVAILABLE (fail closed). */
async function fetchLazerPrice(feedId: number, token: string, channel: string): Promise<LazerPrice> {
  try {
    const response = await latestPriceResponse(feedId, token, channel);
    if (!response.ok) throw new Error(`latest_price responded ${response.status}`);
    const body = (await response.json()) as LazerLatestPriceBody;
    const feed = body.parsed.priceFeeds.find((entry) => entry.priceFeedId === feedId);
    if (!feed) throw new Error('feed absent from latest_price response');
    const price = Number(feed.price) * 10 ** feed.exponent;
    // A malformed price must fail closed here, not surface later as NaN fee math.
    if (!Number.isFinite(price) || price <= 0) throw new Error('latest_price returned a non-finite or zero price');
    return { price, update: Buffer.from(body.leEcdsa.data, 'base64') };
  } catch (error) {
    console.error(`[zenex] Pyth latest_price failed: ${error}`);
    throw pluginError('Private Pyth price is unavailable', {
      code: 'PRICE_UNAVAILABLE',
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** The signed single-feed payload a priced tail carries on-chain. */
export async function fetchMarketUpdate(feedId: number, token: string, channel: string): Promise<Uint8Array> {
  return (await fetchLazerPrice(feedId, token, channel)).update;
}

/** XLM/USD always (fee conversion), plus the named market feed; when the market IS the XLM feed one fetch serves both. */
export async function fetchRelayPrices(feedId: number | null, token: string, channel: string): Promise<RelayPrices> {
  const [xlm, market] = await Promise.all([
    fetchLazerPrice(PYTH.XLM_USD_FEED_ID, token, channel),
    feedId === null || feedId === PYTH.XLM_USD_FEED_ID ? null : fetchLazerPrice(feedId, token, channel),
  ]);
  return { xlmUsd: xlm.price, marketUpdate: feedId === null ? null : (market ?? xlm).update };
}
