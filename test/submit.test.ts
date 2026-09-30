import { describe, test, expect } from 'vitest';
import { Address, Networks, scValToNative } from '@stellar/stellar-sdk';
import { FORWARDER_SLOT, parseSubmitRequest, ROUTER_SLOT, TARGET_SLOT } from '../src/plugin/parse';
import { prepareFinalCall } from '../src/plugin/submit';
import type { RelayPrices } from '../src/plugin/pricing';
import {
  FEE_RECIPIENT,
  FORWARDER_PARSE_CONFIG,
  makeAuthEntry,
  makeFakeRelayer,
  makeForwarderWrap,
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

describe('prepareFinalCall (forwarder mode)', () => {
  function forwardedCall(route: 'calls' | 'fill' | 'try-fill', options: Parameters<typeof makeForwarderWrap>[1] = {}) {
    const func = makeForwarderWrap(route, options);
    const parsed = parseSubmitRequest(
      {
        func,
        auth: [makeAuthEntry(func, USER, { mode: 'forwarder' })],
        feedId: route === 'calls' ? undefined : MARKET_FEED_ID,
      },
      FORWARDER_PARSE_CONFIG
    );
    return { func, parsed };
  }

  test('overwrites only the fee on the calls route, leaving the signed recipient and target args', async () => {
    const { func, parsed } = forwardedCall('calls');
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    // A different recipient handed to submit must not reach the call: the user signed the configured one.
    const call = await prepareFinalCall(parsed, SOURCE, UNPRICED_PRICES, SOURCE, relayer, Networks.TESTNET);

    const before = func.invokeContract().args();
    const after = call.func.invokeContract().args();
    expect(scValToNative(after[FORWARDER_SLOT.feeAmount]!)).toBe(1_500n);
    expect(Address.fromScVal(after[FORWARDER_SLOT.feeRecipient]!).toString()).toBe(FEE_RECIPIENT);
    for (const [slot, value] of before.entries()) {
      if (slot === FORWARDER_SLOT.feeAmount) continue;
      expect(after[slot]!.toXDR('base64')).toBe(value.toXDR('base64'));
    }
    expect(call.auth).toHaveLength(1);
  });

  test.each(['fill', 'try-fill'] as const)('overwrites keeper and price inside target_args on %s', async (route) => {
    const market = Uint8Array.from([7, 7, 7]);
    const { func, parsed } = forwardedCall(route, { market: Uint8Array.from([1]) });
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    const call = await prepareFinalCall(
      parsed,
      FEE_RECIPIENT,
      { xlmUsd: 0.5, marketUpdate: market },
      SOURCE,
      relayer,
      Networks.TESTNET
    );

    const after = call.func.invokeContract().args();
    expect(scValToNative(after[FORWARDER_SLOT.feeAmount]!)).toBe(1_500n);
    expect(Address.fromScVal(after[FORWARDER_SLOT.feeRecipient]!).toString()).toBe(FEE_RECIPIENT);
    const targetArgs = after[FORWARDER_SLOT.targetArgs]!.vec()!;
    expect(Address.fromScVal(targetArgs[TARGET_SLOT.keeper]!).toString()).toBe(USER);
    expect(Buffer.from(targetArgs[TARGET_SLOT.priceUpdate]!.bytes())).toEqual(Buffer.from(market));
    // The batch and the fill user stay exactly as the client round-tripped them.
    const beforeTarget = func.invokeContract().args()[FORWARDER_SLOT.targetArgs]!.vec()!;
    expect(targetArgs[TARGET_SLOT.calls]!.toXDR('base64')).toBe(beforeTarget[TARGET_SLOT.calls]!.toXDR('base64'));
    expect(targetArgs[TARGET_SLOT.user]!.toXDR('base64')).toBe(beforeTarget[TARGET_SLOT.user]!.toXDR('base64'));
  });

  test('rejects a computed fee above the user-signed maximum', async () => {
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    await expect(
      prepareFinalCall(
        forwardedCall('calls').parsed,
        FEE_RECIPIENT,
        { xlmUsd: 5_000, marketUpdate: null },
        SOURCE,
        relayer,
        Networks.TESTNET
      )
    ).rejects.toMatchObject({ code: 'FEE_EXCEEDS_SIGNED_MAXIMUM', status: 422 });
  });
});
