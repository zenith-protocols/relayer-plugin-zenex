import { describe, test, expect } from 'vitest';
import { Networks, xdr } from '@stellar/stellar-sdk';
import { prepareRelayEntries } from '../src/plugin/prepare';
import type { RelayPrepareRequest } from '../src/plugin/types';
import {
  makeAuthEntry,
  makeCallXdr,
  makeFakeRelayer,
  makeSourceAccountEntry,
  makeWrap,
  OTHER_CONTRACT,
  PARSE_CONFIG,
  SOURCE,
  USER,
} from './helpers';

const MARKET = Uint8Array.from([1, 2, 3]);

function makeRequest(overrides: Partial<RelayPrepareRequest> = {}): RelayPrepareRequest {
  return {
    user: USER,
    calls: [makeCallXdr(OTHER_CONTRACT, 'transfer')],
    expirationLedger: 1_000,
    maxFeeAmountAtomic: '1000000',
    ...overrides,
  };
}

describe('prepareRelayEntries', () => {
  test('returns the wrap, stamped auth entries, and decoded outcome', async () => {
    const wrap = makeWrap('calls');
    const relayer = makeFakeRelayer({
      record: {
        auth: [makeAuthEntry(wrap, USER), makeSourceAccountEntry(wrap)],
        retval: xdr.ScVal.scvVec([xdr.ScVal.scvU32(9)]),
        latestLedger: 100,
      },
    });

    const result = await prepareRelayEntries(
      'calls',
      makeRequest(),
      PARSE_CONFIG,
      Networks.TESTNET,
      relayer,
      SOURCE,
      null
    );

    expect(result.func).toBe(wrap.toXDR('base64').toString());
    // The relay's own source-account entry never travels.
    expect(result.authEntries).toHaveLength(1);
    const entry = result.authEntries[0]!;
    expect(entry.signer).toBe(USER);
    expect(entry.signatureExpirationLedger).toBe(1_000);
    expect(entry.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    const stamped = xdr.SorobanAuthorizationEntry.fromXDR(entry.xdr, 'base64');
    expect(stamped.credentials().address().signatureExpirationLedger()).toBe(1_000);
    expect(result.outcome).toEqual({ kind: 'callOutcomes', results: [{ ok: true, value: 9, error: 0 }] });
    expect(result.feeTerms).toEqual({
      token: PARSE_CONFIG.feeToken.contractId,
      decimals: 7,
      maximumAmount: '1000000',
      expirationLedger: 1_000,
    });
  });

  test('builds a priced wrap carrying the market update on try-fill', async () => {
    const wrap = makeWrap('try-fill', { market: MARKET });
    const relayer = makeFakeRelayer({
      record: { auth: [makeAuthEntry(wrap, USER)], retval: xdr.ScVal.scvVec([xdr.ScVal.scvU32(1)]), latestLedger: 100 },
    });

    const result = await prepareRelayEntries(
      'try-fill',
      makeRequest(),
      PARSE_CONFIG,
      Networks.TESTNET,
      relayer,
      SOURCE,
      MARKET
    );
    expect(result.func).toBe(wrap.toXDR('base64').toString());
    expect(result.outcome.kind).toBe('fills');
  });

  test('classifies a failed final try-fill outcome as rests', async () => {
    const wrap = makeWrap('try-fill', { market: MARKET });
    const failed = xdr.ScVal.scvError(xdr.ScError.sceContract(700));
    const relayer = makeFakeRelayer({
      record: { auth: [makeAuthEntry(wrap, USER)], retval: xdr.ScVal.scvVec([failed]), latestLedger: 100 },
    });
    const result = await prepareRelayEntries(
      'try-fill',
      makeRequest(),
      PARSE_CONFIG,
      Networks.TESTNET,
      relayer,
      SOURCE,
      MARKET
    );
    expect(result.outcome.kind).toBe('rests');
    expect(result.outcome.results[0]).toEqual({ ok: false, value: null, error: 700 });
  });

  test('rejects a fill whose primary call is not create_order', async () => {
    const relayer = makeFakeRelayer({});
    await expect(
      prepareRelayEntries('fill', makeRequest(), PARSE_CONFIG, Networks.TESTNET, relayer, SOURCE, MARKET)
    ).rejects.toThrow('Fill prepare requires the primary call to be create_order');
  });

  test('fails closed when a priced route has no market update', async () => {
    const relayer = makeFakeRelayer({});
    await expect(
      prepareRelayEntries('try-fill', makeRequest(), PARSE_CONFIG, Networks.TESTNET, relayer, SOURCE, null)
    ).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });

  test('rejects an expiration the chain would reach before inclusion', async () => {
    const wrap = makeWrap('calls');
    const relayer = makeFakeRelayer({
      record: { auth: [makeAuthEntry(wrap, USER)], retval: xdr.ScVal.scvVec([]), latestLedger: 999 },
    });
    await expect(
      prepareRelayEntries('calls', makeRequest(), PARSE_CONFIG, Networks.TESTNET, relayer, SOURCE, null)
    ).rejects.toMatchObject({ code: 'EXPIRATION_TOO_CLOSE', status: 422 });
  });

  test('rejects a required signer other than the user', async () => {
    const wrap = makeWrap('calls');
    const relayer = makeFakeRelayer({
      record: { auth: [makeAuthEntry(wrap, SOURCE)], retval: xdr.ScVal.scvVec([]), latestLedger: 100 },
    });
    await expect(
      prepareRelayEntries('calls', makeRequest(), PARSE_CONFIG, Networks.TESTNET, relayer, SOURCE, null)
    ).rejects.toThrow('authorization from a signer other than the user');
  });

  test('fails closed on an auth entry rooted outside the built wrap', async () => {
    const wrap = makeWrap('calls');
    const args = wrap.invokeContract().args();
    const foreign = makeAuthEntry(wrap, USER, { rootArgs: [args[0]!, args[2]!, args[3]!] });
    const relayer = makeFakeRelayer({
      record: { auth: [foreign], retval: xdr.ScVal.scvVec([]), latestLedger: 100 },
    });
    await expect(
      prepareRelayEntries('calls', makeRequest(), PARSE_CONFIG, Networks.TESTNET, relayer, SOURCE, null)
    ).rejects.toMatchObject({ code: 'DISCOVERY_INVOCATION_MISMATCH' });
  });

  test('rejects an invocation that needs no user authorization', async () => {
    const wrap = makeWrap('calls');
    const relayer = makeFakeRelayer({
      record: { auth: [makeSourceAccountEntry(wrap)], retval: xdr.ScVal.scvVec([]), latestLedger: 100 },
    });
    await expect(
      prepareRelayEntries('calls', makeRequest(), PARSE_CONFIG, Networks.TESTNET, relayer, SOURCE, null)
    ).rejects.toMatchObject({ code: 'NO_AUTHORIZATION_REQUIRED', status: 422 });
  });

  test('surfaces a discovery simulation failure with the parsed diagnostic', async () => {
    const relayer = makeFakeRelayer({
      record: { error: 'HostError: Error(Contract, #701)\n\nEvent log: data:["order expired"]' },
    });
    await expect(
      prepareRelayEntries('calls', makeRequest(), PARSE_CONFIG, Networks.TESTNET, relayer, SOURCE, null)
    ).rejects.toMatchObject({ code: 'SIMULATION_FAILED' });
  });
});
