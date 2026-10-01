import { describe, test, expect } from 'vitest';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  authProjection,
  decodeCallXdrs,
  FORWARDER_SLOT,
  parseCallOutcome,
  parseSubmitRequest,
  PLACEHOLDER_FEE_AMOUNT_ATOMIC,
  ROUTER_SLOT,
  TARGET_SLOT,
} from '../src/plugin/parse';
import {
  FEE_RECIPIENT,
  FEE_TOKEN,
  FORWARDER,
  FORWARDER_PARSE_CONFIG,
  makeCallXdr,
  makeForwarderWrap,
  makeWrap,
  MARKET_FEED_ID,
  OTHER_CONTRACT,
  PARSE_CONFIG,
  ROUTER,
  SOURCE,
  USER,
  withArg,
} from './helpers';

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
    const parsed = parseSubmitRequest({ func: makeWrap('fill'), auth: [], feedId: MARKET_FEED_ID }, PARSE_CONFIG);
    expect(parsed.priced).toBe(true);
    expect(parsed.feedId).toBe(MARKET_FEED_ID);
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

/** `func` invoking a different entry point with the same args. */
function withEntry(func: xdr.HostFunction, functionName: string): xdr.HostFunction {
  const invocation = func.invokeContract();
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({ contractAddress: invocation.contractAddress(), functionName, args: invocation.args() })
  );
}

/** `func` with `target_args` replaced. */
function withTargetArgs(func: xdr.HostFunction, targetArgs: xdr.ScVal[]): xdr.HostFunction {
  return withArg(func, FORWARDER_SLOT.targetArgs, xdr.ScVal.scvVec(targetArgs));
}

describe('buildForwarderWrap', () => {
  test('wraps the calls route in forward → multicall with the configured recipient', () => {
    const invocation = makeForwarderWrap('calls').invokeContract();
    expect(Address.fromScAddress(invocation.contractAddress()).toString()).toBe(FORWARDER);
    expect(invocation.functionName().toString()).toBe('forward');
    const args = invocation.args();
    expect(args).toHaveLength(9);
    expect(Address.fromScVal(args[FORWARDER_SLOT.feeToken]!).toString()).toBe(FEE_TOKEN);
    expect(scValToNative(args[FORWARDER_SLOT.feeAmount]!)).toBe(PLACEHOLDER_FEE_AMOUNT_ATOMIC);
    expect(scValToNative(args[FORWARDER_SLOT.maximumFee]!)).toBe(1_000_000n);
    expect(args[FORWARDER_SLOT.feeExpiration]!.u32()).toBe(1_000);
    expect(Address.fromScVal(args[FORWARDER_SLOT.targetContract]!).toString()).toBe(ROUTER);
    expect(args[FORWARDER_SLOT.targetFunction]!.sym().toString()).toBe('multicall');
    expect(args[FORWARDER_SLOT.targetArgs]!.vec()).toHaveLength(1);
    expect(Address.fromScVal(args[FORWARDER_SLOT.user]!).toString()).toBe(USER);
    expect(Address.fromScVal(args[FORWARDER_SLOT.feeRecipient]!).toString()).toBe(FEE_RECIPIENT);
  });

  test.each([
    ['fill', 'create_and_fill'],
    ['try-fill', 'create_and_try_fill'],
  ] as const)('wraps %s in forward_dynamic → %s with keeper and price in target_args', (route, target) => {
    const market = Uint8Array.from([9, 9, 9]);
    const invocation = makeForwarderWrap(route, { market }).invokeContract();
    expect(invocation.functionName().toString()).toBe('forward_dynamic');
    const args = invocation.args();
    expect(args[FORWARDER_SLOT.targetFunction]!.sym().toString()).toBe(target);
    const targetArgs = args[FORWARDER_SLOT.targetArgs]!.vec()!;
    expect(targetArgs).toHaveLength(4);
    expect(targetArgs[TARGET_SLOT.calls]!.vec()).toHaveLength(1);
    expect(Address.fromScVal(targetArgs[TARGET_SLOT.user]!).toString()).toBe(USER);
    expect(Address.fromScVal(targetArgs[TARGET_SLOT.keeper]!).toString()).toBe(USER);
    expect(Buffer.from(targetArgs[TARGET_SLOT.priceUpdate]!.bytes())).toEqual(Buffer.from(market));
  });
});

describe('authProjection', () => {
  const xdrOf = (values: xdr.ScVal[]) => values.map((value) => value.toXDR('base64'));

  test('pins calls and the fee terms of a Router wrap', () => {
    const args = makeWrap('fill').invokeContract().args();
    expect(xdrOf(authProjection(makeWrap('fill'), 'router'))).toEqual(xdrOf([args[0]!, args[2]!, args[3]!, args[4]!]));
  });

  test('forward pins the fee terms, recipient, target, and target args', () => {
    const wrap = makeForwarderWrap('calls');
    const args = wrap.invokeContract().args();
    expect(xdrOf(authProjection(wrap, 'forwarder'))).toEqual(
      xdrOf([args[0]!, args[2]!, args[3]!, args[8]!, args[4]!, args[5]!, args[6]!])
    );
  });

  test('forward_dynamic leaves target args out', () => {
    const wrap = makeForwarderWrap('try-fill');
    const args = wrap.invokeContract().args();
    expect(xdrOf(authProjection(wrap, 'forwarder'))).toEqual(
      xdrOf([args[0]!, args[2]!, args[3]!, args[8]!, args[4]!, args[5]!])
    );
  });
});

describe('parseSubmitRequest (forwarder mode)', () => {
  const parse = (func: xdr.HostFunction, feedId?: string) =>
    parseSubmitRequest({ func, auth: [], feedId }, FORWARDER_PARSE_CONFIG);

  test('accepts the calls route and extracts the fee terms', () => {
    expect(parse(makeForwarderWrap('calls'))).toMatchObject({
      mode: 'forwarder',
      priced: false,
      user: USER,
      feeRateBps: 30,
      maximumFeeAtomic: 1_000_000n,
      feeExpiration: 1_000,
      feedId: null,
    });
  });

  test.each(['fill', 'try-fill'] as const)('accepts a priced %s wrap with a feedId', (route) => {
    const parsed = parse(makeForwarderWrap(route), MARKET_FEED_ID);
    expect(parsed).toMatchObject({ mode: 'forwarder', priced: true, feedId: MARKET_FEED_ID });
  });

  test('rejects a priced wrap without a feedId', () => {
    expect(() => parse(makeForwarderWrap('fill'))).toThrow('Priced relay func requires a feedId');
  });

  test('rejects a Router *_with_fee wrap', () => {
    expect(() => parse(makeWrap('calls'))).toThrow('Relay target must be the configured fee forwarder contract');
  });

  test('router mode rejects a forwarder wrap', () => {
    expect(() => parseSubmitRequest({ func: makeForwarderWrap('calls'), auth: [] }, PARSE_CONFIG)).toThrow(
      'Relay target must be the configured Router contract'
    );
  });

  test('rejects another forwarder entry point', () => {
    expect(() => parse(withEntry(makeForwarderWrap('calls'), 'forward_all'))).toThrow(
      'Relay accepts only the fee forwarder forward entry points'
    );
  });

  test('rejects a wrap with the wrong arity', () => {
    const invocation = makeForwarderWrap('calls').invokeContract();
    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: invocation.contractAddress(),
        functionName: invocation.functionName(),
        args: invocation.args().slice(0, 8),
      })
    );
    expect(() => parse(func)).toThrow('Relay accepts only the fee forwarder forward entry points');
  });

  test('rejects a forward target other than the configured Router', () => {
    const func = withArg(
      makeForwarderWrap('calls'),
      FORWARDER_SLOT.targetContract,
      Address.fromString(OTHER_CONTRACT).toScVal()
    );
    expect(() => parse(func)).toThrow('Relay forward target must be the configured Router contract');
  });

  test.each(['transfer_from', 'burn_from', 'multicall_with_fee'])('rejects the target function %s', (name) => {
    const func = withArg(makeForwarderWrap('calls'), FORWARDER_SLOT.targetFunction, xdr.ScVal.scvSymbol(name));
    expect(() => parse(func)).toThrow('Relay forward target function does not match its forwarder entry point');
  });

  test('rejects a priced target under forward, whose target args are signed', () => {
    expect(() => parse(withEntry(makeForwarderWrap('fill'), 'forward'), MARKET_FEED_ID)).toThrow(
      'does not match its forwarder entry point'
    );
  });

  test('rejects multicall under forward_dynamic, which would leave the batch unsigned', () => {
    expect(() => parse(withEntry(makeForwarderWrap('calls'), 'forward_dynamic'))).toThrow(
      'does not match its forwarder entry point'
    );
  });

  test('rejects target args that do not match the Router function', () => {
    const wrap = makeForwarderWrap('fill');
    const targetArgs = wrap.invokeContract().args()[FORWARDER_SLOT.targetArgs]!.vec()!;
    expect(() => parse(withTargetArgs(wrap, targetArgs.slice(0, 3)), MARKET_FEED_ID)).toThrow(
      'Relay forward target args must match the Router function exactly'
    );
  });

  test('rejects a batch that is not a vector of Router Calls', () => {
    expect(() => parse(withTargetArgs(makeForwarderWrap('calls'), [xdr.ScVal.scvU32(1)]))).toThrow(
      'Relay calls must be a vector of Router Calls'
    );
  });

  test('rejects a fill aimed at another user', () => {
    const wrap = makeForwarderWrap('try-fill');
    const targetArgs = wrap.invokeContract().args()[FORWARDER_SLOT.targetArgs]!.vec()!.slice();
    targetArgs[TARGET_SLOT.user] = Address.fromString(SOURCE).toScVal();
    expect(() => parse(withTargetArgs(wrap, targetArgs), MARKET_FEED_ID)).toThrow(
      'Relay fill user must be the signing user'
    );
  });

  test('rejects a recipient other than the configured one', () => {
    const func = withArg(makeForwarderWrap('calls'), FORWARDER_SLOT.feeRecipient, Address.fromString(SOURCE).toScVal());
    expect(() => parse(func)).toThrow('Relay fee recipient is not the configured recipient');
  });

  test('rejects a fee token that is not the configured one', () => {
    const func = withArg(
      makeForwarderWrap('calls'),
      FORWARDER_SLOT.feeToken,
      Address.fromString(OTHER_CONTRACT).toScVal()
    );
    expect(() => parse(func)).toThrow('Relay fee token is not an enabled collateral token');
  });

  test('rejects a non-positive signed fee cap', () => {
    expect(() => parse(makeForwarderWrap('calls', { maximumFeeAtomic: 0n }))).toThrow(
      'Relay fee envelope is outside configured bounds'
    );
  });
});
