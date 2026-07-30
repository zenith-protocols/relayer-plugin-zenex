import { describe, test, expect } from 'vitest';
import { validateAndParsePrepareRequest, validateAndParseSubmitRequest } from '../src/plugin/validation';
import { makeAuthEntry, makeWrap, USER, ROUTER } from './helpers';

const VALID_PREPARE = {
  user: USER,
  calls: ['AAAA'],
  expirationLedger: 1_000,
  maxFeeAmountAtomic: '1000000',
};

describe('validateAndParsePrepareRequest', () => {
  test('accepts a valid body and round-trips every field', () => {
    const out = validateAndParsePrepareRequest({ ...VALID_PREPARE, feedId: 23 });
    expect(out).toEqual({ ...VALID_PREPARE, feedId: 23 });
  });

  test('accepts a contract user and omitted feedId', () => {
    const out = validateAndParsePrepareRequest({ ...VALID_PREPARE, user: ROUTER });
    expect(out.user).toBe(ROUTER);
    expect(out.feedId).toBeUndefined();
  });

  test.each([null, [], 'text', 42])('rejects a non-object body: %j', (body) => {
    expect(() => validateAndParsePrepareRequest(body)).toThrow('Relay request body must be an object');
  });

  test('rejects unknown keys', () => {
    expect(() => validateAndParsePrepareRequest({ ...VALID_PREPARE, extra: 1 })).toThrow(
      'Relay request must not include unknown parameters'
    );
  });

  test.each(['', 'not-an-address', USER.slice(0, -1), 123])('rejects invalid user: %j', (user) => {
    expect(() => validateAndParsePrepareRequest({ ...VALID_PREPARE, user })).toThrow(
      '`user` must be a Stellar account or contract address'
    );
  });

  test.each([[], ['AAAA', 7], [''], 'AAAA'])('rejects invalid calls: %j', (calls) => {
    expect(() => validateAndParsePrepareRequest({ ...VALID_PREPARE, calls })).toThrow(
      '`calls` must be a non-empty array of base64 strings'
    );
  });

  test.each([-1, 1.5, 2 ** 32, '1000', NaN])('rejects invalid expirationLedger: %j', (expirationLedger) => {
    expect(() => validateAndParsePrepareRequest({ ...VALID_PREPARE, expirationLedger })).toThrow(
      '`expirationLedger` must be a u32 ledger sequence'
    );
  });

  test.each(['', 'abc', '12.5', '-1', '1e6', 1000000])(
    'rejects invalid maxFeeAmountAtomic: %j',
    (maxFeeAmountAtomic) => {
      expect(() => validateAndParsePrepareRequest({ ...VALID_PREPARE, maxFeeAmountAtomic })).toThrow(
        '`maxFeeAmountAtomic` must be a non-negative integer string'
      );
    }
  );

  test.each([-1, 1.5, '23', NaN])('rejects invalid feedId: %j', (feedId) => {
    expect(() => validateAndParsePrepareRequest({ ...VALID_PREPARE, feedId })).toThrow(
      '`feedId` must be a non-negative integer'
    );
  });
});

describe('validateAndParseSubmitRequest', () => {
  const wrap = makeWrap('calls');
  const funcXdr = wrap.toXDR('base64').toString();

  test('decodes func and auth from base64', () => {
    const out = validateAndParseSubmitRequest({ func: funcXdr, auth: [funcXdrToAuthXdr()], feedId: 7 });
    expect(out.func.toXDR('base64')).toBe(funcXdr);
    expect(out.auth).toHaveLength(1);
    expect(out.feedId).toBe(7);
  });

  test('rejects unknown keys', () => {
    expect(() => validateAndParseSubmitRequest({ func: funcXdr, auth: [funcXdrToAuthXdr()], skipWait: true })).toThrow(
      'Relay request must not include unknown parameters'
    );
  });

  test.each(['', 42, undefined])('rejects invalid func: %j', (func) => {
    expect(() => validateAndParseSubmitRequest({ func, auth: [funcXdrToAuthXdr()] })).toThrow(
      '`func` must be a non-empty base64 string'
    );
  });

  test.each([[], [''], [7], 'AAAA', undefined])('rejects invalid auth: %j', (auth) => {
    expect(() => validateAndParseSubmitRequest({ func: funcXdr, auth })).toThrow(
      '`auth` must be a non-empty array of base64 strings'
    );
  });

  test('maps undecodable XDR to INVALID_PARAMS', () => {
    expect(() => validateAndParseSubmitRequest({ func: 'not-xdr', auth: ['also-not-xdr'] })).toThrow(
      'Invalid `func` or `auth` encoding'
    );
  });

  test('rejects fractional feedId', () => {
    expect(() => validateAndParseSubmitRequest({ func: funcXdr, auth: [funcXdrToAuthXdr()], feedId: 1.5 })).toThrow(
      '`feedId` must be a non-negative integer'
    );
  });
});

function funcXdrToAuthXdr(): string {
  return makeAuthEntry(makeWrap('calls'), USER).toXDR('base64').toString();
}
