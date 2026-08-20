import { createHash, createHmac } from 'node:crypto';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchMarketUpdate, fetchRelayPrices } from '../src/plugin/pricing';
import type { DataStreamsAccess } from '../src/plugin/pricing';
import { DATASTREAMS } from '../src/plugin/constants';

/**
 * The live XLM/USD V3 report body (nine ABI words, 288 bytes) fetched from the
 * production Data Streams API on 2026-08-11 — the same vector the oracle
 * contract's unit tests pin: price 0.160118639640561900.
 */
const XLM_FEED_ID = '0x000358cb12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a';
const XLM_PRICE = 0.1601186396405619;
const XLM_BODY = Buffer.from(
  '000358cb12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a' +
    '000000000000000000000000000000000000000000000000000000006a7b3e33' +
    '000000000000000000000000000000000000000000000000000000006a7b3e33' +
    '00000000000000000000000000000000000000000000000000009b3d178a78cc' +
    '00000000000000000000000000000000000000000000000000847b434707acfe' +
    '000000000000000000000000000000000000000000000000000000006aa2cb33' +
    '0000000000000000000000000000000000000000000000000238db0dedb1c8ec' +
    '0000000000000000000000000000000000000000000000000238b42058ca6950' +
    '0000000000000000000000000000000000000000000000000238feacdaf8f140',
  'hex'
);

const MARKET_FEED_ID = '0x0003aaaa12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a';

const ACCESS: DataStreamsAccess = {
  host: DATASTREAMS.HOSTS.testnet,
  userId: 'user-uuid',
  hmacSecret: 'hmac-secret',
};

const NOW_MS = 1_786_461_747_000;

/** A V3 body for `feedId` with the vector's shape and the given raw 18-decimal price. */
function bodyFor(feedId: string, priceAtomic18: bigint): Buffer {
  const body = Buffer.from(XLM_BODY);
  Buffer.from(feedId.slice(2), 'hex').copy(body, 0);
  const word = Buffer.alloc(32);
  const hex = (priceAtomic18 < 0n ? (1n << 256n) + priceAtomic18 : priceAtomic18).toString(16).padStart(64, '0');
  Buffer.from(hex, 'hex').copy(word, 0);
  word.copy(body, 192);
  return body;
}

/**
 * Wrap a report body in the REST `fullReport` ABI envelope:
 * abi.encode(bytes32[3] reportContext, bytes reportData, bytes32[] rs, bytes32[] ss, bytes32 rawVs).
 * With a 288-byte body and two signatures this is 736 bytes — the size the
 * tutorial's real testnet blob has.
 */
function encodeFullReport(body: Buffer): Buffer {
  const offsetWord = (offset: number) => {
    const word = Buffer.alloc(32);
    word.writeUInt32BE(offset, 28);
    return word;
  };
  const padded = Buffer.concat([body, Buffer.alloc((32 - (body.length % 32)) % 32)]);
  const dataOffset = 224;
  const rsOffset = dataOffset + 32 + padded.length;
  const ssOffset = rsOffset + 32 + 64;
  return Buffer.concat([
    Buffer.alloc(96, 0xaa), // reportContext
    offsetWord(dataOffset),
    offsetWord(rsOffset),
    offsetWord(ssOffset),
    Buffer.alloc(32, 0xcc), // rawVs
    offsetWord(body.length),
    padded,
    offsetWord(2),
    Buffer.alloc(64, 0xbb), // rs
    offsetWord(2),
    Buffer.alloc(64, 0xdd), // ss
  ]);
}

function reportResponse(feedId: string, fullReport: Buffer) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      report: {
        feedID: feedId,
        validFromTimestamp: 1786461747,
        observationsTimestamp: 1786461747,
        fullReport: `0x${fullReport.toString('hex')}`,
      },
    }),
  };
}

function okReport(feedId: string, priceAtomic18 = 160118639640561900n) {
  return reportResponse(feedId, encodeFullReport(bodyFor(feedId, priceAtomic18)));
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchMarketUpdate', () => {
  test('returns the whole fullReport blob and signs the request with the HMAC scheme', async () => {
    const fullReport = encodeFullReport(XLM_BODY);
    fetchMock.mockResolvedValueOnce(reportResponse(XLM_FEED_ID, fullReport));
    const update = await fetchMarketUpdate(XLM_FEED_ID, ACCESS);
    expect(Buffer.from(update)).toEqual(fullReport);

    const [url, init] = fetchMock.mock.calls[0]!;
    const path = `${DATASTREAMS.LATEST_REPORT_PATH}?feedID=${XLM_FEED_ID}`;
    expect(url).toBe(`${ACCESS.host}${path}`);
    expect(init.method).toBe('GET');
    expect(init.headers['Authorization']).toBe(ACCESS.userId);
    expect(init.headers['X-Authorization-Timestamp']).toBe(String(NOW_MS));
    const emptyBodyHash = createHash('sha256').update('').digest('hex');
    const expected = createHmac('sha256', ACCESS.hmacSecret)
      .update(`GET ${path} ${emptyBodyHash} ${ACCESS.userId} ${NOW_MS}`)
      .digest('hex');
    expect(init.headers['X-Authorization-Signature-SHA256']).toBe(expected);
  });

  test('fetches from the access host verbatim, whatever DS_API_HOST resolved it to', async () => {
    const overridden = { ...ACCESS, host: 'https://ds-proxy.lan:8443/ds' };
    fetchMock.mockResolvedValueOnce(reportResponse(XLM_FEED_ID, encodeFullReport(XLM_BODY)));
    await fetchMarketUpdate(XLM_FEED_ID, overridden);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${overridden.host}${DATASTREAMS.LATEST_REPORT_PATH}?feedID=${XLM_FEED_ID}`
    );
  });

  test('maps an HTTP failure to PRICE_UNAVAILABLE', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    await expect(fetchMarketUpdate(XLM_FEED_ID, ACCESS)).rejects.toMatchObject({
      code: 'PRICE_UNAVAILABLE',
      status: 503,
    });
  });

  test('retries once on a 5xx and succeeds on the second attempt', async () => {
    const fullReport = encodeFullReport(XLM_BODY);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce(reportResponse(XLM_FEED_ID, fullReport));
    const update = await fetchMarketUpdate(XLM_FEED_ID, ACCESS);
    expect(Buffer.from(update)).toEqual(fullReport);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('retries once on a 429, honoring Retry-After', async () => {
    const fullReport = encodeFullReport(XLM_BODY);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === 'retry-after' ? '0' : null) },
      json: async () => ({}),
    });
    fetchMock.mockResolvedValueOnce(reportResponse(XLM_FEED_ID, fullReport));
    const update = await fetchMarketUpdate(XLM_FEED_ID, ACCESS);
    expect(Buffer.from(update)).toEqual(fullReport);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a 429 on both attempts still fails closed as PRICE_UNAVAILABLE', async () => {
    const tooMany = () => ({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === 'retry-after' ? '0' : null) },
      json: async () => ({}),
    });
    fetchMock.mockResolvedValueOnce(tooMany());
    fetchMock.mockResolvedValueOnce(tooMany());
    await expect(fetchMarketUpdate(XLM_FEED_ID, ACCESS)).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('maps a report for a different feed to PRICE_UNAVAILABLE', async () => {
    fetchMock.mockResolvedValueOnce(okReport(MARKET_FEED_ID));
    await expect(fetchMarketUpdate(XLM_FEED_ID, ACCESS)).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });

  test('maps a truncated fullReport to PRICE_UNAVAILABLE', async () => {
    fetchMock.mockResolvedValueOnce(reportResponse(XLM_FEED_ID, encodeFullReport(XLM_BODY).subarray(0, 300)));
    await expect(fetchMarketUpdate(XLM_FEED_ID, ACCESS)).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });

  test.each([0n, -160118639640561900n])('maps a non-positive report price to PRICE_UNAVAILABLE: %s', async (price) => {
    fetchMock.mockResolvedValueOnce(okReport(XLM_FEED_ID, price));
    await expect(fetchMarketUpdate(XLM_FEED_ID, ACCESS)).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });

  test('maps a network error to PRICE_UNAVAILABLE', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(fetchMarketUpdate(XLM_FEED_ID, ACCESS)).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });
});

describe('fetchRelayPrices', () => {
  test('unpriced: fetches only XLM/USD and returns no market payload', async () => {
    fetchMock.mockResolvedValueOnce(okReport(XLM_FEED_ID));
    const prices = await fetchRelayPrices(null, XLM_FEED_ID, ACCESS);
    expect(prices.xlmUsd).toBeCloseTo(XLM_PRICE, 12);
    expect(prices.marketUpdate).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('market feed is the XLM feed: one fetch serves both', async () => {
    fetchMock.mockResolvedValueOnce(okReport(XLM_FEED_ID));
    const prices = await fetchRelayPrices(XLM_FEED_ID, XLM_FEED_ID, ACCESS);
    expect(prices.xlmUsd).toBeCloseTo(XLM_PRICE, 12);
    expect(prices.marketUpdate).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('distinct market feed: fetches both and keeps the market payload', async () => {
    const marketReport = encodeFullReport(bodyFor(MARKET_FEED_ID, 5_000_000_000_000_000_000n));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(`feedID=${XLM_FEED_ID}`)) return okReport(XLM_FEED_ID);
      return reportResponse(MARKET_FEED_ID, marketReport);
    });
    const prices = await fetchRelayPrices(MARKET_FEED_ID, XLM_FEED_ID, ACCESS);
    expect(prices.xlmUsd).toBeCloseTo(XLM_PRICE, 12);
    expect(Buffer.from(prices.marketUpdate!)).toEqual(marketReport);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
