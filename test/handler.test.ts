import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import type { PluginContext, Relayer } from '@openzeppelin/relayer-sdk';
import {
  FEE_RECIPIENT,
  FEE_TOKEN,
  makeAuthEntry,
  makeCallXdr,
  makeFakeRelayer,
  makeWrap,
  MARKET_FEED_ID,
  OTHER_CONTRACT,
  ROUTER,
  SOURCE,
  USER,
  XLM_FEED_ID,
} from './helpers';
import { DATASTREAMS, SUBMIT } from '../src/plugin/constants';

const channelsHandler = vi.fn();
vi.mock('@openzeppelin/relayer-plugin-channels', () => ({
  handler: (context: unknown) => channelsHandler(context),
}));

const fetchMarketUpdate = vi.fn();
const fetchRelayPrices = vi.fn();
vi.mock('../src/plugin/pricing', () => ({
  fetchMarketUpdate: (...args: unknown[]) => fetchMarketUpdate(...args),
  fetchRelayPrices: (...args: unknown[]) => fetchRelayPrices(...args),
}));

import { handler } from '../src/plugin/handler';

const ENV_KEYS = ['STELLAR_NETWORK', 'FUND_RELAYER_ID', 'DS_USER_ID', 'DS_HMAC_SECRET'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let fundRelayerCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STELLAR_NETWORK = 'testnet';
  // Unique per test: the handler caches relayer info per `${network}:${relayerId}`.
  process.env.FUND_RELAYER_ID = `fund-${fundRelayerCounter++}`;
  process.env.DS_USER_ID = 'ds-user-uuid';
  process.env.DS_HMAC_SECRET = 'ds-hmac-secret';
});

const EXPECTED_ACCESS = { host: DATASTREAMS.HOSTS.testnet, userId: 'ds-user-uuid', hmacSecret: 'ds-hmac-secret' };

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function pluginConfig(): Record<string, unknown> {
  return {
    router: ROUTER,
    feeRecipient: FEE_RECIPIENT,
    fees: { feeRateBps: 30, feeToken: { contractId: FEE_TOKEN, decimals: 7 } },
    xlmUsdFeedId: XLM_FEED_ID,
  };
}

function makeContext(
  route: string,
  params: unknown,
  relayer: Relayer,
  overrides: { address?: string; networkType?: string } = {}
): PluginContext {
  const withInfo = {
    ...(relayer as object),
    getRelayer: vi.fn(async () => ({
      address: overrides.address ?? SOURCE,
      network_type: overrides.networkType ?? 'stellar',
    })),
  };
  return {
    route,
    params,
    config: pluginConfig(),
    api: { useRelayer: vi.fn(() => withInfo) },
  } as unknown as PluginContext;
}

describe('handler routing', () => {
  test('delegates the bare route to the embedded channels handler over the margined api', async () => {
    channelsHandler.mockResolvedValueOnce({ channels: true });
    const context = makeContext('', { xdr: 'AAAA' }, makeFakeRelayer({}));
    await expect(handler(context)).resolves.toEqual({ channels: true });
    const forwarded = channelsHandler.mock.calls[0]![0] as PluginContext;
    expect(forwarded).toMatchObject({ route: '', params: context.params, config: context.config });
    expect(forwarded.api).not.toBe(context.api);
  });

  test('answers unknown routes with NOT_FOUND', async () => {
    const context = makeContext('/prepare/nope', {}, makeFakeRelayer({}));
    await expect(handler(context)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});

describe('prepare routes', () => {
  test('prepares an unpriced multicall without touching Data Streams', async () => {
    const wrap = makeWrap('calls');
    const relayer = makeFakeRelayer({
      record: { auth: [makeAuthEntry(wrap, USER)], retval: xdr.ScVal.scvVec([]), latestLedger: 100 },
    });
    const context = makeContext(
      '/prepare/calls',
      {
        user: USER,
        calls: [makeCallXdr(OTHER_CONTRACT, 'transfer')],
        expirationLedger: 1_000,
        maxFeeAmountAtomic: '1000000',
      },
      relayer
    );

    const result = (await handler(context)) as { func: string; authEntries: unknown[] };
    expect(result.func).toBe(wrap.toXDR('base64').toString());
    expect(result.authEntries).toHaveLength(1);
    expect(fetchMarketUpdate).not.toHaveBeenCalled();
  });

  test('fetches the requested market feed on priced routes', async () => {
    const market = Uint8Array.from([5, 5, 5]);
    fetchMarketUpdate.mockResolvedValueOnce(market);
    const wrap = makeWrap('try-fill', { market });
    const relayer = makeFakeRelayer({
      record: { auth: [makeAuthEntry(wrap, USER)], retval: xdr.ScVal.scvVec([xdr.ScVal.scvU32(1)]), latestLedger: 100 },
    });
    const context = makeContext(
      '/prepare/try-fill',
      {
        user: USER,
        calls: [makeCallXdr(OTHER_CONTRACT, 'transfer')],
        expirationLedger: 1_000,
        maxFeeAmountAtomic: '1000000',
        feedId: MARKET_FEED_ID,
      },
      relayer
    );

    const result = (await handler(context)) as { func: string };
    expect(result.func).toBe(wrap.toXDR('base64').toString());
    expect(fetchMarketUpdate).toHaveBeenCalledWith(MARKET_FEED_ID, EXPECTED_ACCESS);
  });

  test('rejects a priced prepare without a feedId before any network call', async () => {
    const context = makeContext(
      '/prepare/fill',
      {
        user: USER,
        calls: [makeCallXdr(OTHER_CONTRACT, 'create_order')],
        expirationLedger: 1_000,
        maxFeeAmountAtomic: '1000000',
      },
      makeFakeRelayer({})
    );
    await expect(handler(context)).rejects.toThrow('Priced prepare requires a feedId');
    expect(fetchMarketUpdate).not.toHaveBeenCalled();
  });

  test('rejects a fund relayer on the wrong network type', async () => {
    const context = makeContext(
      '/prepare/calls',
      {
        user: USER,
        calls: [makeCallXdr(OTHER_CONTRACT, 'transfer')],
        expirationLedger: 1_000,
        maxFeeAmountAtomic: '1000000',
      },
      makeFakeRelayer({}),
      { networkType: 'evm' }
    );
    await expect(handler(context)).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK' });
  });

  test('rejects a fund relayer without an address', async () => {
    const context = makeContext(
      '/prepare/calls',
      {
        user: USER,
        calls: [makeCallXdr(OTHER_CONTRACT, 'transfer')],
        expirationLedger: 1_000,
        maxFeeAmountAtomic: '1000000',
      },
      makeFakeRelayer({}),
      { address: '' }
    );
    await expect(handler(context)).rejects.toMatchObject({ code: 'RELAYER_UNAVAILABLE', status: 502 });
  });
});

describe('submit route', () => {
  test('forwards the repriced call to channels with skipWait', async () => {
    fetchRelayPrices.mockResolvedValueOnce({ xlmUsd: 0.5, marketUpdate: null });
    channelsHandler.mockResolvedValueOnce({ transactionId: 'tx-1', status: 'submitted', hash: null });

    const wrap = makeWrap('calls');
    const signed = makeAuthEntry(wrap, USER, { expiration: 1_000 });
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    const context = makeContext(
      '/submit',
      { func: wrap.toXDR('base64').toString(), auth: [signed.toXDR('base64').toString()] },
      relayer
    );

    const result = await handler(context);
    expect(result).toEqual({ transactionId: 'tx-1', status: 'submitted', hash: null });
    expect(fetchRelayPrices).toHaveBeenCalledWith(null, XLM_FEED_ID, EXPECTED_ACCESS);

    const forwarded = channelsHandler.mock.calls[0]![0] as PluginContext;
    expect(forwarded.params).toMatchObject({ skipWait: true });
    const params = forwarded.params as { func: string; auth: string[] };
    // The forwarded func carries the repriced tail, not the client's placeholder.
    expect(params.func).not.toBe(wrap.toXDR('base64').toString());
    expect(params.auth).toEqual([signed.toXDR('base64').toString()]);
  });

  test('resimulates and submits again after a resource-limit failure', async () => {
    fetchRelayPrices.mockResolvedValue({ xlmUsd: 0.5, marketUpdate: null });
    channelsHandler.mockRejectedValueOnce(
      Object.assign(new Error('Transaction failed'), {
        code: 'ONCHAIN_FAILED',
        details: { reason: 'operation byte-write resources exceeds amount specified' },
      })
    );
    channelsHandler.mockResolvedValueOnce({ transactionId: 'tx-2', status: 'submitted', hash: null });

    const wrap = makeWrap('calls');
    const signed = makeAuthEntry(wrap, USER, { expiration: 1_000 });
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    const context = makeContext(
      '/submit',
      { func: wrap.toXDR('base64').toString(), auth: [signed.toXDR('base64').toString()] },
      relayer
    );

    const result = await handler(context);
    expect(result).toEqual({ transactionId: 'tx-2', status: 'submitted', hash: null });
    expect(channelsHandler).toHaveBeenCalledTimes(2);
    // The second attempt prices a fresh report off a fresh simulation.
    expect(fetchRelayPrices).toHaveBeenCalledTimes(2);
  });

  test('stops after the attempt budget and answers the resource-limit failure', async () => {
    fetchRelayPrices.mockResolvedValue({ xlmUsd: 0.5, marketUpdate: null });
    channelsHandler.mockRejectedValue(
      Object.assign(new Error('Transaction failed'), {
        code: 'ONCHAIN_FAILED',
        details: { reason: 'operation byte-write resources exceeds amount specified' },
      })
    );

    const wrap = makeWrap('calls');
    const signed = makeAuthEntry(wrap, USER, { expiration: 1_000 });
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    const context = makeContext(
      '/submit',
      { func: wrap.toXDR('base64').toString(), auth: [signed.toXDR('base64').toString()] },
      relayer
    );

    await expect(handler(context)).rejects.toMatchObject({ code: 'ONCHAIN_FAILED' });
    expect(channelsHandler).toHaveBeenCalledTimes(SUBMIT.MAX_ATTEMPTS);
  });

  test('answers an unrelated channels failure without a second attempt', async () => {
    fetchRelayPrices.mockResolvedValue({ xlmUsd: 0.5, marketUpdate: null });
    channelsHandler.mockRejectedValue(
      Object.assign(new Error('Insufficient balance'), { code: 'ONCHAIN_FAILED', details: { reason: 'txFailed' } })
    );

    const wrap = makeWrap('calls');
    const signed = makeAuthEntry(wrap, USER, { expiration: 1_000 });
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    const context = makeContext(
      '/submit',
      { func: wrap.toXDR('base64').toString(), auth: [signed.toXDR('base64').toString()] },
      relayer
    );

    await expect(handler(context)).rejects.toMatchObject({ code: 'ONCHAIN_FAILED' });
    expect(channelsHandler).toHaveBeenCalledTimes(1);
  });

  test('caches relayer info across calls on the same fund relayer', async () => {
    fetchRelayPrices.mockResolvedValue({ xlmUsd: 0.5, marketUpdate: null });
    channelsHandler.mockResolvedValue({ transactionId: 'tx', status: 'submitted', hash: null });

    const wrap = makeWrap('calls');
    const signed = makeAuthEntry(wrap, USER, { expiration: 1_000 });
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    const params = { func: wrap.toXDR('base64').toString(), auth: [signed.toXDR('base64').toString()] };

    const context = makeContext('/submit', params, relayer);
    await handler(context);
    await handler(context);
    const fundRelayer = (context.api.useRelayer as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(fundRelayer.getRelayer).toHaveBeenCalledTimes(1);
  });
});
