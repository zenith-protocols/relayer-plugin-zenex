import { describe, test, expect } from 'vitest';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  decodeCallXdrs,
  FORWARDER_SLOT,
  parseCallOutcome,
  parseSubmitRequest,
  PLACEHOLDER_FEE_AMOUNT_ATOMIC,
  signedArgs,
  TARGET_SLOT,
} from '../src/plugin/parse';
import {
  FEE_RECIPIENT,
  FEE_TOKEN,
  FORWARDER,
  makeCallXdr,
  makeWrap,
  MARKET_FEED_ID,
  OTHER_CONTRACT,
  PARSE_CONFIG,
  ROUTER,
  SOURCE,
  USER,
  withArg,
} from './helpers';

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

describe('buildWrap', () => {
  test('wraps the calls route in forward → multicall with the configured recipient', () => {
    const invocation = makeWrap('calls').invokeContract();
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
    const invocation = makeWrap(route, { market }).invokeContract();
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

describe('signedArgs', () => {
  const xdrOf = (values: xdr.ScVal[]) => values.map((value) => value.toXDR('base64'));

  test('forward signs the fee terms, recipient, target, and target args', () => {
    const wrap = makeWrap('calls');
    const args = wrap.invokeContract().args();
    expect(xdrOf(signedArgs(wrap))).toEqual(
      xdrOf([args[0]!, args[2]!, args[3]!, args[8]!, args[4]!, args[5]!, args[6]!])
    );
  });

  test('forward_dynamic leaves target args out', () => {
    const wrap = makeWrap('try-fill');
    const args = wrap.invokeContract().args();
    expect(xdrOf(signedArgs(wrap))).toEqual(xdrOf([args[0]!, args[2]!, args[3]!, args[8]!, args[4]!, args[5]!]));
  });
});

describe('parseSubmitRequest', () => {
  const parse = (func: xdr.HostFunction, feedId?: string) =>
    parseSubmitRequest({ func, auth: [], feedId }, PARSE_CONFIG);

  test('accepts the calls route and extracts the fee terms', () => {
    expect(parse(makeWrap('calls'))).toMatchObject({
      priced: false,
      user: USER,
      feeRateBps: 30,
      maximumFeeAtomic: 1_000_000n,
      feeExpiration: 1_000,
      feedId: null,
    });
  });

  test.each(['fill', 'try-fill'] as const)('accepts a priced %s wrap with a feedId', (route) => {
    expect(parse(makeWrap(route), MARKET_FEED_ID)).toMatchObject({ priced: true, feedId: MARKET_FEED_ID });
  });

  test('rejects a priced wrap without a feedId', () => {
    expect(() => parse(makeWrap('fill'))).toThrow('Priced relay func requires a feedId');
  });

  test('rejects a func that does not invoke a contract', () => {
    const func = xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.alloc(4));
    expect(() => parse(func)).toThrow('Relay func must invoke a contract');
  });

  test('rejects a target other than the configured forwarder', () => {
    expect(() =>
      parseSubmitRequest({ func: makeWrap('calls'), auth: [] }, { ...PARSE_CONFIG, forwarder: ROUTER })
    ).toThrow('Relay target must be the configured fee forwarder contract');
  });

  test('rejects another forwarder entry point', () => {
    expect(() => parse(withEntry(makeWrap('calls'), 'forward_all'))).toThrow(
      'Relay accepts only the fee forwarder forward entry points'
    );
  });

  test('rejects a wrap with the wrong arity', () => {
    const invocation = makeWrap('calls').invokeContract();
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
      makeWrap('calls'),
      FORWARDER_SLOT.targetContract,
      Address.fromString(OTHER_CONTRACT).toScVal()
    );
    expect(() => parse(func)).toThrow('Relay forward target must be the configured Router contract');
  });

  test.each(['transfer_from', 'burn_from', 'multicall_with_fee'])('rejects the target function %s', (name) => {
    const func = withArg(makeWrap('calls'), FORWARDER_SLOT.targetFunction, xdr.ScVal.scvSymbol(name));
    expect(() => parse(func)).toThrow('Relay forward target function does not match its forwarder entry point');
  });

  test('rejects a priced target under forward, whose target args are signed', () => {
    expect(() => parse(withEntry(makeWrap('fill'), 'forward'), MARKET_FEED_ID)).toThrow(
      'does not match its forwarder entry point'
    );
  });

  test('rejects multicall under forward_dynamic, which would leave the batch unsigned', () => {
    expect(() => parse(withEntry(makeWrap('calls'), 'forward_dynamic'))).toThrow(
      'does not match its forwarder entry point'
    );
  });

  test('rejects target args that do not match the Router function', () => {
    const wrap = makeWrap('fill');
    const targetArgs = wrap.invokeContract().args()[FORWARDER_SLOT.targetArgs]!.vec()!;
    expect(() => parse(withTargetArgs(wrap, targetArgs.slice(0, 3)), MARKET_FEED_ID)).toThrow(
      'Relay forward target args must match the Router function exactly'
    );
  });

  test('rejects a batch that is not a vector of Router Calls', () => {
    expect(() => parse(withTargetArgs(makeWrap('calls'), [xdr.ScVal.scvU32(1)]))).toThrow(
      'Relay calls must be a vector of Router Calls'
    );
  });

  test('rejects a fill aimed at another user', () => {
    const wrap = makeWrap('try-fill');
    const targetArgs = wrap.invokeContract().args()[FORWARDER_SLOT.targetArgs]!.vec()!.slice();
    targetArgs[TARGET_SLOT.user] = Address.fromString(SOURCE).toScVal();
    expect(() => parse(withTargetArgs(wrap, targetArgs), MARKET_FEED_ID)).toThrow(
      'Relay fill user must be the signing user'
    );
  });

  test('rejects a recipient other than the configured one', () => {
    const func = withArg(makeWrap('calls'), FORWARDER_SLOT.feeRecipient, Address.fromString(SOURCE).toScVal());
    expect(() => parse(func)).toThrow('Relay fee recipient is not the configured recipient');
  });

  test('rejects a fee token that is not the configured one', () => {
    const func = withArg(makeWrap('calls'), FORWARDER_SLOT.feeToken, Address.fromString(OTHER_CONTRACT).toScVal());
    expect(() => parse(func)).toThrow('Relay fee token is not an enabled collateral token');
  });

  test('rejects a non-positive signed fee cap', () => {
    expect(() => parse(makeWrap('calls', { maximumFeeAtomic: 0n }))).toThrow(
      'Relay fee envelope is outside configured bounds'
    );
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
