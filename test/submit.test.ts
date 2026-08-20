import { describe, test, expect } from 'vitest';
import { Address, Networks, scValToNative } from '@stellar/stellar-sdk';
import { parseSubmitRequest, ROUTER_SLOT } from '../src/plugin/parse';
import { prepareFinalCall } from '../src/plugin/submit';
import type { RelayPrices } from '../src/plugin/pricing';
import {
  FEE_RECIPIENT,
  makeAuthEntry,
  makeFakeRelayer,
  makeWrap,
  MARKET_FEED_ID,
  PARSE_CONFIG,
  SOURCE,
  USER,
} from './helpers';

const UNPRICED_PRICES: RelayPrices = { xlmUsd: 0.5, marketUpdate: null };

function parsedCall(route: 'calls' | 'fill' = 'calls', options: Parameters<typeof makeWrap>[1] = {}) {
  const func = makeWrap(route, options);
  return parseSubmitRequest(
    { func, auth: [makeAuthEntry(func, USER)], feedId: route === 'calls' ? undefined : MARKET_FEED_ID },
    PARSE_CONFIG
  );
}

describe('prepareFinalCall', () => {
  test('prices the fee off the simulation and overwrites the tail', async () => {
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    const call = await prepareFinalCall(
      parsedCall(),
      FEE_RECIPIENT,
      UNPRICED_PRICES,
      SOURCE,
      relayer,
      Networks.TESTNET
    );

    const args = call.func.invokeContract().args();
    // 1_000_000 stroops * 0.5 USD * 30bps = 1_500 atomic units
    expect(scValToNative(args[ROUTER_SLOT.feeAmount]!)).toBe(1_500n);
    expect(Address.fromScVal(args[ROUTER_SLOT.feeRecipient]!).toString()).toBe(FEE_RECIPIENT);
    expect(call.auth).toHaveLength(1);
  });

  test('rounds the fee up so a fractional unit never undercharges', async () => {
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '333', latestLedger: 100 } });
    const call = await prepareFinalCall(
      parsedCall(),
      FEE_RECIPIENT,
      UNPRICED_PRICES,
      SOURCE,
      relayer,
      Networks.TESTNET
    );
    // 333 * 0.5 * 0.003 = 0.4995 → 1
    expect(scValToNative(call.func.invokeContract().args()[ROUTER_SLOT.feeAmount]!)).toBe(1n);
  });

  test('overwrites keeper and price update on priced calls', async () => {
    const market = Uint8Array.from([7, 7, 7]);
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    const call = await prepareFinalCall(
      parsedCall('fill'),
      FEE_RECIPIENT,
      { xlmUsd: 0.5, marketUpdate: market },
      SOURCE,
      relayer,
      Networks.TESTNET
    );
    const args = call.func.invokeContract().args();
    expect(Address.fromScVal(args[ROUTER_SLOT.keeper]!).toString()).toBe(USER);
    expect(Buffer.from(args[ROUTER_SLOT.priceUpdate]!.bytes())).toEqual(Buffer.from(market));
  });

  test('rejects a signed expiration the chain would reach before inclusion', async () => {
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 999 } });
    await expect(
      prepareFinalCall(parsedCall(), FEE_RECIPIENT, UNPRICED_PRICES, SOURCE, relayer, Networks.TESTNET)
    ).rejects.toMatchObject({ code: 'EXPIRATION_TOO_CLOSE', status: 422 });
  });

  test('rejects a computed fee above the user-signed maximum', async () => {
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    await expect(
      prepareFinalCall(
        parsedCall(),
        FEE_RECIPIENT,
        { xlmUsd: 5_000, marketUpdate: null },
        SOURCE,
        relayer,
        Networks.TESTNET
      )
    ).rejects.toMatchObject({ code: 'FEE_EXCEEDS_SIGNED_MAXIMUM', status: 422 });
  });

  test('propagates an enforce-mode auth failure as a signed-auth validation error', async () => {
    const relayer = makeFakeRelayer({
      enforce: { error: 'HostError: Error(Auth, InvalidAction)\n\nsignature has expired' },
    });
    await expect(
      prepareFinalCall(parsedCall(), FEE_RECIPIENT, UNPRICED_PRICES, SOURCE, relayer, Networks.TESTNET)
    ).rejects.toMatchObject({ code: 'SIMULATION_SIGNED_AUTH_VALIDATION_FAILED' });
  });

  test('maps a missing simulation receipt to an invalid-response error', async () => {
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '', latestLedger: 100 } });
    await expect(
      prepareFinalCall(parsedCall(), FEE_RECIPIENT, UNPRICED_PRICES, SOURCE, relayer, Networks.TESTNET)
    ).rejects.toMatchObject({ code: 'SIMULATION_INVALID_RESPONSE' });
  });
});
