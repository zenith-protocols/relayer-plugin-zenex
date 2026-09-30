import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { PluginContext, Relayer } from '@openzeppelin/relayer-sdk';
import {
  FEE_RECIPIENT,
  FEE_TOKEN,
  FORWARDER,
  makeAuthEntry,
  makeCallXdr,
  makeFakeRelayer,
  makeForwarderWrap,
  makeWrap,
  MARKET_FEED_ID,
  OTHER_CONTRACT,
  ROUTER,
  SOURCE,
  USER,
  XLM_FEED_ID,
} from './helpers';
import { DATASTREAMS } from '../src/plugin/constants';
import { FORWARDER_SLOT } from '../src/plugin/parse';

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
  overrides: { address?: string; networkType?: string; config?: Record<string, unknown> } = {}
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
    config: overrides.config ?? pluginConfig(),
    api: { useRelayer: vi.fn(() => withInfo) },
  } as unknown as PluginContext;
}

describe('handler routing', () => {
  test('delegates the bare route to the embedded channels handler untouched', async () => {
    channelsHandler.mockResolvedValueOnce({ channels: true });
    const context = makeContext('', { xdr: 'AAAA' }, makeFakeRelayer({}));
    await expect(handler(context)).resolves.toEqual({ channels: true });
    expect(channelsHandler).toHaveBeenCalledWith(context);
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

describe('forwarder mode', () => {
  const forwarderConfig = () => ({ ...pluginConfig(), forwarder: FORWARDER });

  test('prepares the calls route as a forwarder wrap', async () => {
    const wrap = makeForwarderWrap('calls');
    const relayer = makeFakeRelayer({
      record: {
        auth: [makeAuthEntry(wrap, USER, { mode: 'forwarder' })],
        retval: xdr.ScVal.scvVec([]),
        latestLedger: 100,
      },
    });
    const context = makeContext(
      '/prepare/calls',
      {
        user: USER,
        calls: [makeCallXdr(OTHER_CONTRACT, 'transfer')],
        expirationLedger: 1_000,
        maxFeeAmountAtomic: '1000000',
      },
      relayer,
      { config: forwarderConfig() }
    );

    const result = (await handler(context)) as { func: string; authEntries: unknown[] };
    expect(result.func).toBe(wrap.toXDR('base64').toString());
    expect(result.authEntries).toHaveLength(1);
  });

  test('submits the repriced forwarder call with the signed recipient intact', async () => {
    fetchRelayPrices.mockResolvedValueOnce({ xlmUsd: 0.5, marketUpdate: null });
    channelsHandler.mockResolvedValueOnce({ transactionId: 'tx-1', status: 'submitted', hash: null });

    const wrap = makeForwarderWrap('calls');
    const signed = makeAuthEntry(wrap, USER, { expiration: 1_000, mode: 'forwarder' });
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    const context = makeContext(
      '/submit',
      { func: wrap.toXDR('base64').toString(), auth: [signed.toXDR('base64').toString()] },
      relayer,
      { config: forwarderConfig() }
    );

    await expect(handler(context)).resolves.toEqual({ transactionId: 'tx-1', status: 'submitted', hash: null });
    const params = (channelsHandler.mock.calls[0]![0] as PluginContext).params as { func: string; auth: string[] };
    const args = xdr.HostFunction.fromXDR(params.func, 'base64').invokeContract().args();
    expect(scValToNative(args[FORWARDER_SLOT.feeAmount]!)).toBe(1_500n);
    expect(Address.fromScVal(args[FORWARDER_SLOT.feeRecipient]!).toString()).toBe(FEE_RECIPIENT);
    expect(params.auth).toEqual([signed.toXDR('base64').toString()]);
  });

  test('rejects a Router *_with_fee wrap at submit', async () => {
    const wrap = makeWrap('calls');
    const context = makeContext(
      '/submit',
      { func: wrap.toXDR('base64').toString(), auth: [makeAuthEntry(wrap, USER).toXDR('base64').toString()] },
      makeFakeRelayer({}),
      { config: forwarderConfig() }
    );
    await expect(handler(context)).rejects.toThrow('Relay target must be the configured fee forwarder contract');
    expect(channelsHandler).not.toHaveBeenCalled();
  });
});
