import { describe, test, expect } from 'vitest';
import { Account, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import type { PluginAPI, Relayer } from '@openzeppelin/relayer-sdk';
import { applyResourceMargin, simulateFinal, withResourceMargin } from '../src/plugin/simulation';
import { RESOURCE_MARGIN } from '../src/plugin/constants';
import { makeAuthEntry, makeFakeRelayer, makeTransactionData, makeWrap, SOURCE, USER } from './helpers';

/** The footprint of the reverted fill: a small write set and a modest instruction count. */
const FOOTPRINT = { instructions: 10_000_000, diskReadBytes: 4_000, writeBytes: 1_992, resourceFee: '100000' };

function simulationResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    latestLedger: 100,
    minResourceFee: FOOTPRINT.resourceFee,
    transactionData: makeTransactionData(FOOTPRINT),
    ...overrides,
  };
}

function resourcesOf(transactionData: string): xdr.SorobanResources {
  return xdr.SorobanTransactionData.fromXDR(transactionData, 'base64').resources();
}

describe('applyResourceMargin', () => {
  test('raises every declared dimension over the simulated footprint', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const margined = applyResourceMargin(simulationResult() as any);
    const resources = resourcesOf(margined.transactionData!);

    // 1_992 bytes: the 512-byte floor beats the 20 percent ratio.
    expect(resources.writeBytes()).toBe(1_992 + RESOURCE_MARGIN.MIN_BYTES);
    // 4_000 bytes: the 20 percent ratio beats the floor.
    expect(resources.diskReadBytes()).toBe(4_000 + 800);
    expect(resources.instructions()).toBe(10_000_000 + 2_000_000);
  });

  test('raises the resource fee by the largest dimension growth', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const margined = applyResourceMargin(simulationResult() as any);
    // Write bytes grow by 2_504 / 1_992, the largest of the three, so the fee
    // grows by 1.258 at millifactor precision: 100_000 stroops become 125_800.
    expect(BigInt(margined.minResourceFee!)).toBe(125_800n);
    expect(xdr.SorobanTransactionData.fromXDR(margined.transactionData!, 'base64').resourceFee().toString()).toBe(
      margined.minResourceFee
    );
  });

  test('declares no more instructions than the ledger cap', () => {
    const atCap = { ...FOOTPRINT, instructions: RESOURCE_MARGIN.MAX_INSTRUCTIONS - 1_000 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const margined = applyResourceMargin({ ...simulationResult(), transactionData: makeTransactionData(atCap) } as any);

    expect(resourcesOf(margined.transactionData!).instructions()).toBe(RESOURCE_MARGIN.MAX_INSTRUCTIONS);
  });

  test('passes a result without transaction data through', () => {
    const result = simulationResult({ transactionData: undefined, error: 'HostError' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(applyResourceMargin(result as any)).toBe(result);
  });

  test('the assembled transaction declares the margined resources', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const margined = applyResourceMargin(simulationResult() as any);
    const func = makeWrap('calls');
    const transaction = new TransactionBuilder(new Account(SOURCE, '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
      sorobanData: xdr.SorobanTransactionData.fromXDR(margined.transactionData!, 'base64'),
    })
      .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
      .setTimeout(60)
      .build();

    const declared = transaction.toEnvelope().v1().tx().ext().sorobanData()!;
    expect(declared.resources().writeBytes()).toBe(1_992 + RESOURCE_MARGIN.MIN_BYTES);
    expect(declared.resources().diskReadBytes()).toBe(4_000 + 800);
    expect(declared.resources().instructions()).toBe(10_000_000 + 2_000_000);
    expect(declared.resourceFee().toString()).toBe(margined.minResourceFee);
  });
});

describe('withResourceMargin', () => {
  function makeApi(relayer: Relayer): PluginAPI {
    return { useRelayer: () => relayer } as unknown as PluginAPI;
  }

  test('margins the simulation answer the assembly reads', async () => {
    const relayer = makeFakeRelayer({
      enforce: { minResourceFee: FOOTPRINT.resourceFee, transactionData: makeTransactionData(FOOTPRINT) },
    });
    const margined = withResourceMargin(makeApi(relayer)).useRelayer('fund');
    const response = await margined.rpc({
      jsonrpc: '2.0',
      id: '1',
      method: 'simulateTransaction',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: { transaction: 'AAAA', authMode: 'enforce' } as any,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = response.result as any;
    expect(resourcesOf(result.transactionData).writeBytes()).toBe(1_992 + RESOURCE_MARGIN.MIN_BYTES);
    expect(BigInt(result.minResourceFee)).toBeGreaterThan(BigInt(FOOTPRINT.resourceFee));
  });

  test('leaves an rpc call that is not a simulation alone', async () => {
    const relayer = { rpc: async () => ({ jsonrpc: '2.0', id: 1, result: { sequence: '7' } }) } as unknown as Relayer;
    const margined = withResourceMargin(makeApi(relayer)).useRelayer('fund');
    const response = await margined.rpc({
      jsonrpc: '2.0',
      id: '1',
      method: 'getLatestLedger',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: {} as any,
    });

    expect(response.result).toEqual({ sequence: '7' });
  });

  test('prices the fee off the margined resource fee', async () => {
    const relayer = makeFakeRelayer({
      enforce: { minResourceFee: FOOTPRINT.resourceFee, transactionData: makeTransactionData(FOOTPRINT) },
    });
    const func = makeWrap('calls');
    const receipt = await simulateFinal(
      func,
      [makeAuthEntry(func, USER)],
      SOURCE,
      withResourceMargin(makeApi(relayer)).useRelayer('fund'),
      Networks.TESTNET
    );

    expect(receipt.minResourceFeeStroops).toBeGreaterThan(BigInt(FOOTPRINT.resourceFee));
  });
});
