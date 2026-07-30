import { describe, test, expect } from 'vitest';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  decodeCallXdrs,
  parseCallOutcome,
  parseSubmitRequest,
  PLACEHOLDER_FEE_AMOUNT_ATOMIC,
  ROUTER_SLOT,
} from '../src/plugin/parse';
import { FEE_TOKEN, makeCallXdr, makeWrap, OTHER_CONTRACT, PARSE_CONFIG, ROUTER, USER } from './helpers';

describe('decodeCallXdrs', () => {
  test('decodes a Router Call ScMap', () => {
    const [call] = decodeCallXdrs([makeCallXdr(OTHER_CONTRACT, 'transfer', [xdr.ScVal.scvU32(7)])]);
    expect(call).toMatchObject({ contract: OTHER_CONTRACT, func: 'transfer' });
    expect(call!.args).toHaveLength(1);
  });

  test('rejects undecodable XDR with the call index', () => {
    expect(() => decodeCallXdrs(['not-xdr'])).toThrow('Invalid `calls[0]` encoding');
  });

  test('rejects a non-Call ScVal', () => {
    expect(() => decodeCallXdrs([xdr.ScVal.scvU32(1).toXDR('base64').toString()])).toThrow(
      'calls[0] must be a Router Call'
    );
  });

  test('rejects a Call map missing required keys', () => {
    const partial = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('func'), val: xdr.ScVal.scvSymbol('transfer') }),
    ]);
    expect(() => decodeCallXdrs([partial.toXDR('base64').toString()])).toThrow('calls[0] must be a Router Call');
  });
});

describe('buildRouterWrap', () => {
  test('lays out the unpriced ABI slots', () => {
    const wrap = makeWrap('calls');
    const invocation = wrap.invokeContract();
    expect(Address.fromScAddress(invocation.contractAddress()).toString()).toBe(ROUTER);
    expect(invocation.functionName().toString()).toBe('multicall_with_fee');
    const args = invocation.args();
    expect(args).toHaveLength(7);
    expect(Address.fromScVal(args[ROUTER_SLOT.user]!).toString()).toBe(USER);
    expect(Address.fromScVal(args[ROUTER_SLOT.feeToken]!).toString()).toBe(FEE_TOKEN);
    expect(scValToNative(args[ROUTER_SLOT.maximumFee]!)).toBe(1_000_000n);
    expect(args[ROUTER_SLOT.feeExpiration]!.u32()).toBe(1_000);
    expect(scValToNative(args[ROUTER_SLOT.feeAmount]!)).toBe(PLACEHOLDER_FEE_AMOUNT_ATOMIC);
  });

  test('appends keeper and price update on priced wraps', () => {
    const market = Uint8Array.from([9, 9, 9]);
    const wrap = makeWrap('try-fill', { market });
    const invocation = wrap.invokeContract();
    expect(invocation.functionName().toString()).toBe('create_and_try_fill_with_fee');
    const args = invocation.args();
    expect(args).toHaveLength(9);
    expect(Address.fromScVal(args[ROUTER_SLOT.keeper]!).toString()).toBe(USER);
    expect(Buffer.from(args[ROUTER_SLOT.priceUpdate]!.bytes())).toEqual(Buffer.from(market));
  });
});

describe('parseSubmitRequest', () => {
  test('accepts an unpriced wrap and extracts the signed prefix', () => {
    const parsed = parseSubmitRequest({ func: makeWrap('calls'), auth: [] }, PARSE_CONFIG);
    expect(parsed).toMatchObject({
      priced: false,
      user: USER,
      feeRateBps: 30,
      maximumFeeAtomic: 1_000_000n,
      feeExpiration: 1_000,
      feedId: null,
    });
  });

  test('accepts a priced wrap with a feedId', () => {
    const parsed = parseSubmitRequest({ func: makeWrap('fill'), auth: [], feedId: 23 }, PARSE_CONFIG);
    expect(parsed.priced).toBe(true);
    expect(parsed.feedId).toBe(23);
  });

  test('rejects a priced wrap without a feedId', () => {
    expect(() => parseSubmitRequest({ func: makeWrap('try-fill'), auth: [] }, PARSE_CONFIG)).toThrow(
      'Priced relay func requires a feedId'
    );
  });

  test('rejects a target other than the configured Router', () => {
    const config = { ...PARSE_CONFIG, router: OTHER_CONTRACT };
    expect(() => parseSubmitRequest({ func: makeWrap('calls'), auth: [] }, config)).toThrow(
      'Relay target must be the configured Router contract'
    );
  });

  test('rejects a non-*_with_fee entry point', () => {
    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(ROUTER).toScAddress(),
        functionName: 'multicall',
        args: makeWrap('calls').invokeContract().args(),
      })
    );
    expect(() => parseSubmitRequest({ func, auth: [] }, PARSE_CONFIG)).toThrow(
      'Relay accepts only the Router *_with_fee entry points'
    );
  });

  test('rejects a wrap with the wrong arity', () => {
    const invocation = makeWrap('calls').invokeContract();
    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: invocation.contractAddress(),
        functionName: invocation.functionName(),
        args: invocation.args().slice(0, 6),
      })
    );
    expect(() => parseSubmitRequest({ func, auth: [] }, PARSE_CONFIG)).toThrow(
      'Relay accepts only the Router *_with_fee entry points'
    );
  });

  test('rejects a fee token that is not the configured one', () => {
    const config = { ...PARSE_CONFIG, feeToken: { ...PARSE_CONFIG.feeToken, contractId: OTHER_CONTRACT } };
    expect(() => parseSubmitRequest({ func: makeWrap('calls'), auth: [] }, config)).toThrow(
      'Relay fee token is not an enabled collateral token'
    );
  });

  test('rejects a non-positive signed fee cap', () => {
    expect(() =>
      parseSubmitRequest({ func: makeWrap('calls', { maximumFeeAtomic: 0n }), auth: [] }, PARSE_CONFIG)
    ).toThrow('Relay fee envelope is outside configured bounds');
  });

  test('rejects a func that does not invoke a contract', () => {
    const func = xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.alloc(4));
    expect(() => parseSubmitRequest({ func, auth: [] }, PARSE_CONFIG)).toThrow('Relay func must invoke a contract');
  });
});

describe('parseCallOutcome', () => {
  test('decodes a landed value', () => {
    expect(parseCallOutcome(xdr.ScVal.scvU32(9))).toEqual({ ok: true, value: 9, error: 0 });
  });

  test('decodes a contract error code', () => {
    const raw = xdr.ScVal.scvError(xdr.ScError.sceContract(42));
    expect(parseCallOutcome(raw)).toEqual({ ok: false, value: undefined, error: 42 });
  });

  test('maps host failures to the untyped sentinel', () => {
    const raw = xdr.ScVal.scvError(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction()));
    expect(parseCallOutcome(raw)).toEqual({ ok: false, value: undefined, error: 0xffffffff });
  });
});
