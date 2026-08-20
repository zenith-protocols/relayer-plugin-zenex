/**
 * session.ts
 *
 * Session-rule policy for the relay: exact structural validation of
 * `add_context_rule` / `remove_context_rule` batch calls, ported from the
 * retired V3 relay (zenex-infra 27c8a2f apps/transaction-relay/src/policy.ts,
 * validateSessionAdd/-Remove) onto the V2 smart-account shapes the frontend
 * builds today (zenex-trade src/wallet/smartAccountRules.ts).
 *
 * The Router imposes no target gate on batch calls, and Soroban auth only
 * proves the user signed — it says nothing about what the signed rule grants.
 * These checks are what keeps the relay from co-signing a session rule that
 * names a foreign policy contract, an unknown verifier, a never-expiring key,
 * a wrong rule name, or a scope beyond the configured market surface. Calls
 * whose function is not a session-rule mutation pass through untouched; the
 * chain's own auth remains their gate.
 *
 * Expiry is two-phase: the shape check here requires a concrete u32
 * `valid_until` (a void "no expiry" is rejected as a shape mismatch), and the
 * window against the live ledger is enforced after the pipeline's simulation
 * via {@link validateSessionRuleExpiries} — the same place the existing fee
 * expiration gates live.
 */

import { Address, StrKey, xdr } from '@stellar/stellar-sdk';
import { pluginError } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS } from './constants';
import { Call, RelayParseConfig, SessionRulePolicy } from './types';

/** One INVALID_SESSION_RULE (400) rejection for every non-conforming session call. */
function invalidSessionRule(message: string): never {
  throw pluginError(message, { code: 'INVALID_SESSION_RULE', status: HTTP_STATUS.BAD_REQUEST });
}

/** The decoded address, or null when the value is not a supported ScAddress. */
function scAddressOrNull(value: xdr.ScVal | undefined): string | null {
  if (value === undefined || value.switch() !== xdr.ScValType.scvAddress()) return null;
  try {
    return Address.fromScVal(value).toString();
  } catch {
    return null;
  }
}

function requireShape(call: Call, expected: readonly xdr.ScValType[], label: string): void {
  if (call.args.length !== expected.length || call.args.some((value, index) => value.switch() !== expected[index])) {
    invalidSessionRule(`${label} does not match its exact ABI`);
  }
}

/**
 * The policy install params exactly as the frontend encodes them:
 * `{ allowed_contracts: [trading, collateral, router], allowed_transfer_to: trading }`
 * for one configured market capability.
 */
function validateSessionConfig(value: xdr.ScVal, session: SessionRulePolicy, router: string): void {
  if (value.switch() !== xdr.ScValType.scvMap()) {
    invalidSessionRule('Session policy parameters must be a SessionConfig map');
  }
  const fields = new Map<string, xdr.ScVal>();
  for (const entry of value.map() ?? []) {
    if (entry.key().switch() !== xdr.ScValType.scvSymbol()) {
      invalidSessionRule('SessionConfig keys must be symbols');
    }
    const key = entry.key().sym().toString();
    if (fields.has(key)) invalidSessionRule('SessionConfig keys must be unique');
    fields.set(key, entry.val());
  }
  const contracts = fields.get('allowed_contracts');
  const destination = scAddressOrNull(fields.get('allowed_transfer_to'));
  if (
    fields.size !== 2 ||
    contracts === undefined ||
    contracts.switch() !== xdr.ScValType.scvVec() ||
    destination === null
  ) {
    invalidSessionRule('Session policy parameters do not match SessionConfig');
  }
  const allowed = (contracts.vec() ?? []).map((element) => scAddressOrNull(element));
  const market = session.markets.find((candidate) => candidate.trading === allowed[0]);
  if (
    allowed.length !== 3 ||
    market === undefined ||
    allowed[1] !== market.collateral ||
    allowed[2] !== router ||
    destination !== market.trading
  ) {
    invalidSessionRule('Session rule must encode exactly one configured market capability');
  }
}

/** Returns the rule's `valid_until` ledger; the window check runs post-simulation. */
function validateSessionAdd(call: Call, user: string, session: SessionRulePolicy, router: string): number {
  if (!StrKey.isValidContract(user) || call.contract !== user) {
    invalidSessionRule('Session rules may target only the requesting smart account');
  }
  requireShape(
    call,
    [
      xdr.ScValType.scvVec(),
      xdr.ScValType.scvString(),
      xdr.ScValType.scvU32(),
      xdr.ScValType.scvVec(),
      xdr.ScValType.scvMap(),
    ],
    'add_context_rule'
  );
  const context = call.args[0]!.vec() ?? [];
  if (
    context.length !== 1 ||
    context[0]!.switch() !== xdr.ScValType.scvSymbol() ||
    context[0]!.sym().toString() !== 'Default'
  ) {
    invalidSessionRule('Session context rule type must be Default');
  }
  if (call.args[1]!.str().toString() !== session.ruleName) {
    invalidSessionRule('Session rule name does not match the configured rule name');
  }
  const validUntil = call.args[2]!.u32();
  const signers = call.args[3]!.vec() ?? [];
  const signer = signers[0]?.switch() === xdr.ScValType.scvVec() ? (signers[0].vec() ?? []) : [];
  if (
    signers.length !== 1 ||
    signer.length !== 3 ||
    signer[0]!.switch() !== xdr.ScValType.scvSymbol() ||
    signer[0]!.sym().toString() !== 'External' ||
    scAddressOrNull(signer[1]) !== session.ed25519Verifier ||
    signer[2]!.switch() !== xdr.ScValType.scvBytes() ||
    signer[2]!.bytes().byteLength !== 32
  ) {
    invalidSessionRule(
      'Session rule must register exactly one External signer through the configured ed25519 verifier'
    );
  }
  const policies = call.args[4]!.map() ?? [];
  if (policies.length !== 1 || scAddressOrNull(policies[0]!.key()) !== session.policy) {
    invalidSessionRule('Session rule must install exactly the configured session policy');
  }
  validateSessionConfig(policies[0]!.val(), session, router);
  return validUntil;
}

function validateSessionRemove(call: Call, user: string): void {
  if (!StrKey.isValidContract(user) || call.contract !== user) {
    invalidSessionRule('Session rules may target only the requesting smart account');
  }
  requireShape(call, [xdr.ScValType.scvU32()], 'remove_context_rule');
  if (call.args[0]!.u32() === 0) {
    invalidSessionRule('Context rule 0 (the primary signer rule) cannot be removed through the relay');
  }
}

/**
 * Validates every session-rule call in a batch against the configured policy
 * and returns the `valid_until` ledgers of the adds, for the post-simulation
 * window check. Batches without session calls return empty untouched — the
 * trading flows keep their exact behavior. A session call with no `session`
 * config fails closed.
 */
export function validateSessionRuleCalls(calls: readonly Call[], user: string, config: RelayParseConfig): number[] {
  const expiries: number[] = [];
  for (const call of calls) {
    if (call.func !== 'add_context_rule' && call.func !== 'remove_context_rule') continue;
    const session = config.session;
    if (session === undefined) {
      invalidSessionRule('Session rules are not enabled on this relay');
    }
    if (call.func === 'add_context_rule') {
      expiries.push(validateSessionAdd(call, user, session, config.router));
    } else {
      validateSessionRemove(call, user);
    }
  }
  return expiries;
}

/**
 * The ported expiry window: every rule must expire after the live ledger and
 * within the configured maximum duration. Runs after the pipeline's
 * simulation, next to the existing fee-expiration gates.
 */
export function validateSessionRuleExpiries(
  expiries: readonly number[],
  currentLedger: number,
  maxDurationLedgers: number
): void {
  for (const validUntil of expiries) {
    if (validUntil <= currentLedger || validUntil > currentLedger + maxDurationLedgers) {
      throw pluginError('Session rule expiry is outside the configured ledger window', {
        code: 'SESSION_EXPIRY_OUT_OF_WINDOW',
        status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
        details: { validUntil, currentLedger, maxDurationLedgers },
      });
    }
  }
}
