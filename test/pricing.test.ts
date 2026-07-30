import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchMarketUpdate, fetchRelayPrices } from '../src/plugin/pricing';
import { PYTH } from '../src/plugin/constants';

const UPDATE = Buffer.from([1, 2, 3, 4]);

function lazerBody(feedId: number, price: string | number = '123450000', exponent = -8) {
  return {
    parsed: { priceFeeds: [{ priceFeedId: feedId, price, exponent }] },
    leEcdsa: { data: UPDATE.toString('base64') },
  };
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMarketUpdate', () => {
  test('returns the signed leEcdsa payload and sends the entitled channel', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(lazerBody(7)));
    const update = await fetchMarketUpdate(7, 'token', 'fixed_rate@1000ms');
    expect(Buffer.from(update)).toEqual(UPDATE);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(PYTH.LATEST_PRICE_URL);
    expect(init.headers.authorization).toBe('Bearer token');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ priceFeedIds: [7], channel: 'fixed_rate@1000ms', formats: ['leEcdsa'] });
  });

  test('maps an HTTP failure to PRICE_UNAVAILABLE', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
    await expect(fetchMarketUpdate(7, 'token', 'chan')).rejects.toMatchObject({
      code: 'PRICE_UNAVAILABLE',
      status: 503,
    });
  });

  test('maps a missing feed to PRICE_UNAVAILABLE', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(lazerBody(99)));
    await expect(fetchMarketUpdate(7, 'token', 'chan')).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });

  test.each(['garbage', '0', 0])('maps a non-finite or zero price to PRICE_UNAVAILABLE: %j', async (price) => {
    fetchMock.mockResolvedValueOnce(okResponse(lazerBody(7, price)));
    await expect(fetchMarketUpdate(7, 'token', 'chan')).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });

  test('maps a network error to PRICE_UNAVAILABLE', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(fetchMarketUpdate(7, 'token', 'chan')).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });
});

describe('fetchRelayPrices', () => {
  test('unpriced: fetches only XLM/USD and returns no market payload', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(lazerBody(PYTH.XLM_USD_FEED_ID)));
    const prices = await fetchRelayPrices(null, 'token', 'chan');
    expect(prices.xlmUsd).toBeCloseTo(1.2345);
    expect(prices.marketUpdate).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('market feed is the XLM feed: one fetch serves both', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(lazerBody(PYTH.XLM_USD_FEED_ID)));
    const prices = await fetchRelayPrices(PYTH.XLM_USD_FEED_ID, 'token', 'chan');
    expect(prices.marketUpdate).not.toBeNull();
    expect(Buffer.from(prices.marketUpdate!)).toEqual(UPDATE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('distinct market feed: fetches both and keeps the market payload', async () => {
    const marketUpdate = Buffer.from([9, 8, 7]);
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const feedId = JSON.parse(init.body).priceFeedIds[0] as number;
      if (feedId === PYTH.XLM_USD_FEED_ID) return okResponse(lazerBody(feedId));
      return okResponse({
        parsed: { priceFeeds: [{ priceFeedId: feedId, price: '5000000000', exponent: -8 }] },
        leEcdsa: { data: marketUpdate.toString('base64') },
      });
    });
    const prices = await fetchRelayPrices(42, 'token', 'chan');
    expect(prices.xlmUsd).toBeCloseTo(1.2345);
    expect(Buffer.from(prices.marketUpdate!)).toEqual(marketUpdate);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
