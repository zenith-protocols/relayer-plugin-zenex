/**
 * Session-rule policy tests: the exact add/remove_context_rule shapes the
 * relay co-signs (ported from the retired V3 relay's policy.ts), wired
 * through both pipelines — prepare (structural before simulation, expiry
 * window after) and submit (structural at parse, expiry window after the
 * final simulation). Conforming fixtures mirror the frontend encoder
 * (zenex-trade src/wallet/smartAccountRules.ts) byte for byte.
 */

import { describe, test, expect } from 'vitest';
import { Address, Networks, StrKey, xdr } from '@stellar/stellar-sdk';
import { parseSubmitRequest } from '../src/plugin/parse';
import { prepareRelayEntries } from '../src/plugin/prepare';
import { validateSessionRuleCalls, validateSessionRuleExpiries } from '../src/plugin/session';
import { prepareFinalCall } from '../src/plugin/submit';
import type { RelayPrices } from '../src/plugin/pricing';
import type { Call, RelayParseConfig, SessionRulePolicy } from '../src/plugin/types';
import {
  FEE_RECIPIENT,
  makeAuthEntry,
  makeCallXdr,
  makeFakeRelayer,
  makeWrap,
  OTHER_CONTRACT,
  PARSE_CONFIG,
  ROUTER,
  SOURCE,
  USER,
} from './helpers';

const SMART_ACCOUNT = StrKey.encodeContract(Buffer.alloc(32, 7));
const TRADING = StrKey.encodeContract(Buffer.alloc(32, 8));
const COLLATERAL = StrKey.encodeContract(Buffer.alloc(32, 9));
const SESSION_POLICY = StrKey.encodeContract(Buffer.alloc(32, 10));
const ED25519_VERIFIER = StrKey.encodeContract(Buffer.alloc(32, 11));
const SESSION_KEY = Buffer.alloc(32, 12);

const SESSION_RULE_POLICY: SessionRulePolicy = {
  policy: SESSION_POLICY,
  ed25519Verifier: ED25519_VERIFIER,
  ruleName: 'zenex-session',
  maxDurationLedgers: 17_280,
  markets: [{ trading: TRADING, collateral: COLLATERAL }],
};

const SESSION_CONFIG: RelayParseConfig = { ...PARSE_CONFIG, session: SESSION_RULE_POLICY };

const addr = (value: string) => Address.fromString(value).toScVal();
const sym = (value: string) => xdr.ScVal.scvSymbol(value);
const entry = (key: xdr.ScVal, val: xdr.ScVal) => new xdr.ScMapEntry({ key, val });

/** The frontend's SessionConfig encoding: sorted symbol keys. */
function sessionConfigVal(
  allowedContracts: readonly string[] = [TRADING, COLLATERAL, ROUTER],
  transferTo: string = TRADING
): xdr.ScVal {
  return xdr.ScVal.scvMap([
    entry(sym('allowed_contracts'), xdr.ScVal.scvVec(allowedContracts.map(addr))),
    entry(sym('allowed_transfer_to'), addr(transferTo)),
  ]);
}

function signerVal(kind = 'External', verifier = ED25519_VERIFIER, keyData: Buffer = SESSION_KEY): xdr.ScVal {
  return xdr.ScVal.scvVec([sym(kind), addr(verifier), xdr.ScVal.scvBytes(keyData)]);
}

interface AddRuleOverrides {
  context?: xdr.ScVal;
  name?: string;
  validUntil?: xdr.ScVal;
  signers?: xdr.ScVal;
  policies?: xdr.ScVal;
  policyContract?: string;
  sessionConfig?: xdr.ScVal;
  extraArg?: xdr.ScVal;
}

/** `add_context_rule` args exactly as the frontend encodes them, with per-slot overrides. */
function addRuleArgs(overrides: AddRuleOverrides = {}): xdr.ScVal[] {
  const args = [
    overrides.context ?? xdr.ScVal.scvVec([sym('Default')]),
    xdr.ScVal.scvString(overrides.name ?? 'zenex-session'),
    overrides.validUntil ?? xdr.ScVal.scvU32(10_000),
    overrides.signers ?? xdr.ScVal.scvVec([signerVal()]),
    overrides.policies ??
      xdr.ScVal.scvMap([
        entry(addr(overrides.policyContract ?? SESSION_POLICY), overrides.sessionConfig ?? sessionConfigVal()),
      ]),
  ];
  if (overrides.extraArg) args.push(overrides.extraArg);
  return args;
}

function call(contract: string, func: string, args: xdr.ScVal[]): Call {
  return { contract, func, args };
}

const conformingAdd = () => call(SMART_ACCOUNT, 'add_context_rule', addRuleArgs());
const conformingRemove = () => call(SMART_ACCOUNT, 'remove_context_rule', [xdr.ScVal.scvU32(1)]);

describe('validateSessionRuleCalls', () => {
  test('accepts a conforming add and returns its valid_until', () => {
    expect(validateSessionRuleCalls([conformingAdd()], SMART_ACCOUNT, SESSION_CONFIG)).toEqual([10_000]);
  });

  test('accepts a conforming remove', () => {
    expect(validateSessionRuleCalls([conformingRemove()], SMART_ACCOUNT, SESSION_CONFIG)).toEqual([]);
  });

  test('accepts a second configured market capability', () => {
    const config: RelayParseConfig = {
      ...PARSE_CONFIG,
      session: {
        ...SESSION_RULE_POLICY,
        markets: [...SESSION_RULE_POLICY.markets, { trading: OTHER_CONTRACT, collateral: COLLATERAL }],
      },
    };
    const add = call(
      SMART_ACCOUNT,
      'add_context_rule',
      addRuleArgs({ sessionConfig: sessionConfigVal([OTHER_CONTRACT, COLLATERAL, ROUTER], OTHER_CONTRACT) })
    );
    expect(validateSessionRuleCalls([add], SMART_ACCOUNT, config)).toEqual([10_000]);
  });

  test('leaves non-session calls untouched, whatever their args', () => {
    const junk = call(OTHER_CONTRACT, 'transfer', [xdr.ScVal.scvVoid()]);
    expect(validateSessionRuleCalls([junk], USER, PARSE_CONFIG)).toEqual([]);
  });

  test('fails closed when the relay has no session config', () => {
    expect(() => validateSessionRuleCalls([conformingAdd()], SMART_ACCOUNT, PARSE_CONFIG)).toThrow(
      'Session rules are not enabled on this relay'
    );
    expect(() => validateSessionRuleCalls([conformingRemove()], SMART_ACCOUNT, PARSE_CONFIG)).toThrow(
      'Session rules are not enabled on this relay'
    );
  });

  test.each([
    ['another contract', call(OTHER_CONTRACT, 'add_context_rule', addRuleArgs()), SMART_ACCOUNT],
    ['a G-account user', call(SMART_ACCOUNT, 'add_context_rule', addRuleArgs()), USER],
  ])('rejects an add targeting %s', (_label, add, user) => {
    expect(() => validateSessionRuleCalls([add], user, SESSION_CONFIG)).toThrow(
      'Session rules may target only the requesting smart account'
    );
  });

  test.each([
    ['a void valid_until (no expiry)', addRuleArgs({ validUntil: xdr.ScVal.scvVoid() })],
    ['a trailing extra argument', addRuleArgs({ extraArg: xdr.ScVal.scvU32(1) })],
    ['a truncated argument list', addRuleArgs().slice(0, 4)],
  ])('rejects an add with %s', (_label, args) => {
    expect(() =>
      validateSessionRuleCalls([call(SMART_ACCOUNT, 'add_context_rule', args)], SMART_ACCOUNT, SESSION_CONFIG)
    ).toThrow('add_context_rule does not match its exact ABI');
  });

  test.each([
    ['a CallContract context', xdr.ScVal.scvVec([sym('CallContract'), addr(TRADING)])],
    ['an empty context vec', xdr.ScVal.scvVec([])],
  ])('rejects %s', (_label, context) => {
    expect(() =>
      validateSessionRuleCalls(
        [call(SMART_ACCOUNT, 'add_context_rule', addRuleArgs({ context }))],
        SMART_ACCOUNT,
        SESSION_CONFIG
      )
    ).toThrow('Session context rule type must be Default');
  });

  test('rejects a wrong rule name', () => {
    const add = call(SMART_ACCOUNT, 'add_context_rule', addRuleArgs({ name: 'evil-session' }));
    expect(() => validateSessionRuleCalls([add], SMART_ACCOUNT, SESSION_CONFIG)).toThrow(
      'Session rule name does not match the configured rule name'
    );
  });

  test.each([
    ['two signers', xdr.ScVal.scvVec([signerVal(), signerVal()])],
    ['no signers', xdr.ScVal.scvVec([])],
    ['a non-External signer', xdr.ScVal.scvVec([signerVal('Delegated')])],
    ['an unknown verifier', xdr.ScVal.scvVec([signerVal('External', OTHER_CONTRACT)])],
    ['a non-32-byte key', xdr.ScVal.scvVec([signerVal('External', ED25519_VERIFIER, Buffer.alloc(31, 1))])],
  ])('rejects %s', (_label, signers) => {
    expect(() =>
      validateSessionRuleCalls(
        [call(SMART_ACCOUNT, 'add_context_rule', addRuleArgs({ signers }))],
        SMART_ACCOUNT,
        SESSION_CONFIG
      )
    ).toThrow('Session rule must register exactly one External signer through the configured ed25519 verifier');
  });

  test.each([
    ['a foreign policy contract', addRuleArgs({ policyContract: OTHER_CONTRACT })],
    [
      'two installed policies',
      addRuleArgs({
        policies: xdr.ScVal.scvMap([
          entry(addr(SESSION_POLICY), sessionConfigVal()),
          entry(addr(OTHER_CONTRACT), sessionConfigVal()),
        ]),
      }),
    ],
    ['no installed policy', addRuleArgs({ policies: xdr.ScVal.scvMap([]) })],
  ])('rejects %s', (_label, args) => {
    expect(() =>
      validateSessionRuleCalls([call(SMART_ACCOUNT, 'add_context_rule', args)], SMART_ACCOUNT, SESSION_CONFIG)
    ).toThrow('Session rule must install exactly the configured session policy');
  });

  test.each([
    ['a non-map SessionConfig', xdr.ScVal.scvU32(1), 'Session policy parameters must be a SessionConfig map'],
    [
      'an extra SessionConfig field',
      xdr.ScVal.scvMap([
        entry(sym('allowed_contracts'), xdr.ScVal.scvVec([TRADING, COLLATERAL, ROUTER].map(addr))),
        entry(sym('allowed_transfer_to'), addr(TRADING)),
        entry(sym('extra'), xdr.ScVal.scvU32(1)),
      ]),
      'Session policy parameters do not match SessionConfig',
    ],
    [
      'a missing allowed_transfer_to',
      xdr.ScVal.scvMap([entry(sym('allowed_contracts'), xdr.ScVal.scvVec([TRADING, COLLATERAL, ROUTER].map(addr)))]),
      'Session policy parameters do not match SessionConfig',
    ],
  ])('rejects %s', (_label, sessionConfig, message) => {
    expect(() =>
      validateSessionRuleCalls(
        [call(SMART_ACCOUNT, 'add_context_rule', addRuleArgs({ sessionConfig }))],
        SMART_ACCOUNT,
        SESSION_CONFIG
      )
    ).toThrow(message);
  });

  test.each([
    ['an unconfigured trading contract', sessionConfigVal([OTHER_CONTRACT, COLLATERAL, ROUTER], OTHER_CONTRACT)],
    ['a wrong collateral', sessionConfigVal([TRADING, OTHER_CONTRACT, ROUTER])],
    ['a wrong router', sessionConfigVal([TRADING, COLLATERAL, OTHER_CONTRACT])],
    ['a swapped contract order', sessionConfigVal([TRADING, ROUTER, COLLATERAL])],
    ['a fourth allowed contract', sessionConfigVal([TRADING, COLLATERAL, ROUTER, OTHER_CONTRACT])],
    ['a truncated allowed list', sessionConfigVal([TRADING, COLLATERAL])],
    ['a foreign transfer destination', sessionConfigVal([TRADING, COLLATERAL, ROUTER], OTHER_CONTRACT)],
    ['the collateral as transfer destination', sessionConfigVal([TRADING, COLLATERAL, ROUTER], COLLATERAL)],
  ])('rejects a scope with %s', (_label, sessionConfig) => {
    expect(() =>
      validateSessionRuleCalls(
        [call(SMART_ACCOUNT, 'add_context_rule', addRuleArgs({ sessionConfig }))],
        SMART_ACCOUNT,
        SESSION_CONFIG
      )
    ).toThrow('Session rule must encode exactly one configured market capability');
  });

  test('rejects removing context rule 0 (the primary signer rule)', () => {
    const remove = call(SMART_ACCOUNT, 'remove_context_rule', [xdr.ScVal.scvU32(0)]);
    expect(() => validateSessionRuleCalls([remove], SMART_ACCOUNT, SESSION_CONFIG)).toThrow(
      'Context rule 0 (the primary signer rule) cannot be removed through the relay'
    );
  });

  test.each([
    ['a non-u32 rule id', [xdr.ScVal.scvString('1')]],
    ['extra arguments', [xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(2)]],
  ])('rejects a remove with %s', (_label, args) => {
    expect(() =>
      validateSessionRuleCalls([call(SMART_ACCOUNT, 'remove_context_rule', args)], SMART_ACCOUNT, SESSION_CONFIG)
    ).toThrow('remove_context_rule does not match its exact ABI');
  });

  test('rejects a remove targeting another contract', () => {
    const remove = call(OTHER_CONTRACT, 'remove_context_rule', [xdr.ScVal.scvU32(1)]);
    expect(() => validateSessionRuleCalls([remove], SMART_ACCOUNT, SESSION_CONFIG)).toThrow(
      'Session rules may target only the requesting smart account'
    );
  });
});

describe('validateSessionRuleExpiries', () => {
  test('accepts an expiry inside the window', () => {
    expect(() => validateSessionRuleExpiries([101, 17_380], 100, 17_280)).not.toThrow();
  });

  test.each([
    ['at the live ledger', 100],
    ['behind the live ledger', 50],
    ['beyond the maximum duration', 17_381],
  ])('rejects an expiry %s', (_label, validUntil) => {
    expect(() => validateSessionRuleExpiries([validUntil], 100, 17_280)).toThrow(
      'Session rule expiry is outside the configured ledger window'
    );
  });
});

// --- Pipeline wiring -------------------------------------------------------

const sessionCallXdr = () => makeCallXdr(SMART_ACCOUNT, 'add_context_rule', addRuleArgs());

function sessionPrepareRequest(calls: string[] = [sessionCallXdr()]) {
  return { user: SMART_ACCOUNT, calls, expirationLedger: 1_000, maxFeeAmountAtomic: '1000000' };
}

describe('prepare pipeline session gates', () => {
  test('prepares a conforming session add', async () => {
    const wrap = makeWrap('calls', { user: SMART_ACCOUNT, calls: [sessionCallXdr()] });
    const relayer = makeFakeRelayer({ record: { auth: [makeAuthEntry(wrap, SMART_ACCOUNT)], latestLedger: 100 } });
    const result = await prepareRelayEntries(
      'calls',
      sessionPrepareRequest(),
      SESSION_CONFIG,
      Networks.TESTNET,
      relayer,
      SOURCE,
      null
    );
    expect(result.authEntries).toHaveLength(1);
    expect(result.authEntries[0]!.signer).toBe(SMART_ACCOUNT);
  });

  test('rejects a non-conforming session add before any simulation', async () => {
    const calls = [makeCallXdr(SMART_ACCOUNT, 'add_context_rule', addRuleArgs({ name: 'evil-session' }))];
    // An empty fake relayer would throw on any rpc call: the rejection must come first.
    await expect(
      prepareRelayEntries(
        'calls',
        sessionPrepareRequest(calls),
        SESSION_CONFIG,
        Networks.TESTNET,
        makeFakeRelayer({}),
        SOURCE,
        null
      )
    ).rejects.toThrow('Session rule name does not match the configured rule name');
  });

  test('rejects a session add when the relay has no session config', async () => {
    await expect(
      prepareRelayEntries(
        'calls',
        sessionPrepareRequest(),
        PARSE_CONFIG,
        Networks.TESTNET,
        makeFakeRelayer({}),
        SOURCE,
        null
      )
    ).rejects.toThrow('Session rules are not enabled on this relay');
  });

  test('rejects a session expiry outside the window of the live ledger', async () => {
    const calls = [
      makeCallXdr(SMART_ACCOUNT, 'add_context_rule', addRuleArgs({ validUntil: xdr.ScVal.scvU32(20_000) })),
    ];
    const wrap = makeWrap('calls', { user: SMART_ACCOUNT, calls });
    // Fee expiration (1_000) clears ledger 100 + 3; the rule (20_000 > 100 + 1_000) does not.
    const relayer = makeFakeRelayer({ record: { auth: [makeAuthEntry(wrap, SMART_ACCOUNT)], latestLedger: 100 } });
    const config: RelayParseConfig = {
      ...PARSE_CONFIG,
      session: { ...SESSION_RULE_POLICY, maxDurationLedgers: 1_000 },
    };
    await expect(
      prepareRelayEntries('calls', sessionPrepareRequest(calls), config, Networks.TESTNET, relayer, SOURCE, null)
    ).rejects.toThrow('Session rule expiry is outside the configured ledger window');
  });
});

describe('submit pipeline session gates', () => {
  const UNPRICED_PRICES: RelayPrices = { xlmUsd: 0.5, marketUpdate: null };

  function submitParsed(options: { validUntil?: number; expirationLedger?: number; config?: RelayParseConfig } = {}) {
    const calls = [
      makeCallXdr(
        SMART_ACCOUNT,
        'add_context_rule',
        addRuleArgs(options.validUntil === undefined ? {} : { validUntil: xdr.ScVal.scvU32(options.validUntil) })
      ),
    ];
    const func = makeWrap('calls', { user: SMART_ACCOUNT, calls, expirationLedger: options.expirationLedger });
    return parseSubmitRequest({ func, auth: [makeAuthEntry(func, SMART_ACCOUNT)] }, options.config ?? SESSION_CONFIG);
  }

  test('parses a conforming session add and carries its expiry window', () => {
    const parsed = submitParsed();
    expect(parsed.sessionRules).toEqual({ expiries: [10_000], maxDurationLedgers: 17_280 });
  });

  test('parses a batch without session calls with no session window', () => {
    const func = makeWrap('calls', { user: SMART_ACCOUNT });
    const parsed = parseSubmitRequest({ func, auth: [makeAuthEntry(func, SMART_ACCOUNT)] }, SESSION_CONFIG);
    expect(parsed.sessionRules).toBeNull();
  });

  test('rejects a non-conforming session add at parse', () => {
    const calls = [makeCallXdr(SMART_ACCOUNT, 'add_context_rule', addRuleArgs({ policyContract: OTHER_CONTRACT }))];
    const func = makeWrap('calls', { user: SMART_ACCOUNT, calls });
    expect(() => parseSubmitRequest({ func, auth: [makeAuthEntry(func, SMART_ACCOUNT)] }, SESSION_CONFIG)).toThrow(
      'Session rule must install exactly the configured session policy'
    );
  });

  test('rejects a session add when the relay has no session config', () => {
    const calls = [sessionCallXdr()];
    const func = makeWrap('calls', { user: SMART_ACCOUNT, calls });
    expect(() => parseSubmitRequest({ func, auth: [makeAuthEntry(func, SMART_ACCOUNT)] }, PARSE_CONFIG)).toThrow(
      'Session rules are not enabled on this relay'
    );
  });

  test('finalizes a conforming session add inside the window', async () => {
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 100 } });
    const finalCall = await prepareFinalCall(
      submitParsed(),
      FEE_RECIPIENT,
      UNPRICED_PRICES,
      SOURCE,
      relayer,
      Networks.TESTNET
    );
    expect(finalCall.auth).toHaveLength(1);
  });

  test('rejects a session expiry outside the window of the live ledger', async () => {
    // Fee expiration (30_000) clears the live ledger; the session rule (9_999 <= 10_000) does not.
    const parsed = submitParsed({ validUntil: 9_999, expirationLedger: 30_000 });
    const relayer = makeFakeRelayer({ enforce: { minResourceFee: '1000000', latestLedger: 10_000 } });
    await expect(
      prepareFinalCall(parsed, FEE_RECIPIENT, UNPRICED_PRICES, SOURCE, relayer, Networks.TESTNET)
    ).rejects.toThrow('Session rule expiry is outside the configured ledger window');
  });
});
