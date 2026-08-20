/**
 * parse.ts
 *
 * Wire decoding and Router ABI for the zenex relay plugin.
 */

import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { pluginError, Json } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS } from './constants';
import { validateSessionRuleCalls } from './session';
import {
  Call,
  ParsedRelayCall,
  RelayParseConfig,
  RelayPrepareRoute,
  RelaySubmitRequest,
  RouterWrapPrefix,
  RouterWrapTail,
} from './types';

/** One INVALID_PARAMS (400) rejection for every bad request. */
export function invalidParams(message: string, details?: Json): never {
  throw pluginError(message, { code: 'INVALID_PARAMS', status: HTTP_STATUS.BAD_REQUEST, details });
}

function scAddress(value: xdr.ScVal, label: string): string {
  if (value.switch() !== xdr.ScValType.scvAddress()) invalidParams(`${label} must be an address`);
  try {
    return Address.fromScVal(value).toString();
  } catch {
    return invalidParams(`${label} must be a supported Stellar address`);
  }
}

/** Decodes one prepare-body call ScVal into the SDK's `Call` struct, which the SDK re-encodes canonically. */
function decodeRouterCall(value: xdr.ScVal, label: string): Call {
  if (value.switch() !== xdr.ScValType.scvMap()) return invalidParams(`${label} must be a Router Call`);
  let args: xdr.ScVal[] | null = null;
  let contract: string | null = null;
  let func: string | null = null;
  for (const entry of value.map() ?? []) {
    if (entry.key().switch() !== xdr.ScValType.scvSymbol()) continue;
    const key = entry.key().sym().toString();
    if (key === 'args' && entry.val().switch() === xdr.ScValType.scvVec()) {
      args = [...(entry.val().vec() ?? [])];
    } else if (key === 'contract' && entry.val().switch() === xdr.ScValType.scvAddress()) {
      try {
        contract = Address.fromScVal(entry.val()).toString();
      } catch {
        return invalidParams(`${label} names an unsupported contract address`);
      }
    } else if (key === 'func' && entry.val().switch() === xdr.ScValType.scvSymbol()) {
      func = entry.val().sym().toString();
    }
  }
  if (args === null || contract === null || func === null) {
    return invalidParams(`${label} must be a Router Call`);
  }
  return { contract, func, args };
}

/** Decodes the prepare-body `calls` into SDK `Call` structs. */
export function decodeCallXdrs(values: readonly string[]): Call[] {
  return values.map((value, index) => {
    const label = `calls[${index}]`;
    let decoded: xdr.ScVal;
    try {
      decoded = xdr.ScVal.fromXDR(value, 'base64');
    } catch (e) {
      return invalidParams(`Invalid \`${label}\` encoding`, { message: e instanceof Error ? e.message : String(e) });
    }
    return decodeRouterCall(decoded, label);
  });
}

/** Encode one `Call` as the Router's `Call` ScMap (keys in sorted order). */
function callToScVal(call: Call): xdr.ScVal {
  const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  return xdr.ScVal.scvMap([
    entry('args', xdr.ScVal.scvVec(call.args)),
    entry('contract', Address.fromString(call.contract).toScVal()),
    entry('func', xdr.ScVal.scvSymbol(call.func)),
  ]);
}

/** `error` on a non-contract (host) failure in a decoded call outcome. */
const UNTYPED_FAILURE = 0xffffffff;

/** Parse one raw `multicall_try`-style outcome ScVal: the call's value when it landed, its failure code when not. */
export function parseCallOutcome(raw: xdr.ScVal): { ok: boolean; value: unknown; error: number } {
  if (raw.switch() === xdr.ScValType.scvError()) {
    const error = raw.error();
    const code = error.switch() === xdr.ScErrorType.sceContract() ? error.contractCode() : UNTYPED_FAILURE;
    return { ok: false, value: undefined, error: code };
  }
  return { ok: true, value: scValToNative(raw), error: 0 };
}

/** The Router entry point each prepare route wraps the calls in. */
const ROUTER_WRAP_FUNCTIONS = {
  calls: 'multicall_with_fee',
  'try-fill': 'create_and_try_fill_with_fee',
  fill: 'create_and_fill_with_fee',
} as const satisfies Record<RelayPrepareRoute, string>;

/**
 * Argument slots of every Router `*_with_fee` wrap, fixed by the deployed ABI:
 *   multicall_with_fee(calls, user, fee_token, max_fee_amount, fee_expiration, fee_amount, fee_recipient)
 *   create_and_[try_]fill_with_fee(...those, keeper, price)
 */
export const ROUTER_SLOT = {
  calls: 0,
  user: 1,
  feeToken: 2,
  maximumFee: 3,
  feeExpiration: 4,
  feeAmount: 5,
  feeRecipient: 6,
  keeper: 7,
  priceUpdate: 8,
} as const;

const UNPRICED_ARGUMENTS = ROUTER_SLOT.feeRecipient + 1;
const PRICED_ARGUMENTS = ROUTER_SLOT.priceUpdate + 1;

/** The unsigned-tail fee placeholder; submit overwrites the whole tail with the converged fee. */
export const PLACEHOLDER_FEE_AMOUNT_ATOMIC = 1n;

/** Builds the route's Router `*_with_fee` outer host function per the `ROUTER_SLOT` ABI. */
export function buildRouterWrap(
  router: string,
  route: RelayPrepareRoute,
  prefix: RouterWrapPrefix,
  tail: RouterWrapTail
): xdr.HostFunction {
  const args = [
    xdr.ScVal.scvVec(prefix.calls.map(callToScVal)),
    Address.fromString(prefix.user).toScVal(),
    Address.fromString(prefix.feeToken).toScVal(),
    nativeToScVal(prefix.maximumFeeAtomic, { type: 'i128' }),
    xdr.ScVal.scvU32(prefix.feeExpirationLedger),
    nativeToScVal(tail.feeAmountAtomic, { type: 'i128' }),
    Address.fromString(tail.feeRecipient).toScVal(),
  ];
  if (route !== 'calls') {
    args.push(Address.fromString(tail.keeper!).toScVal(), xdr.ScVal.scvBytes(Buffer.from(tail.priceUpdate!)));
  }
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(router).toScAddress(),
      functionName: ROUTER_WRAP_FUNCTIONS[route],
      args,
    })
  );
}

// Router ABI policy over a decoded submit body; the signed entries pass through untouched — diverging
// entries fail the pre-handoff simulation via the Router's `require_auth_for_args`.
export function parseSubmitRequest(request: RelaySubmitRequest, config: RelayParseConfig): ParsedRelayCall {
  const { func, auth } = request;

  if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    invalidParams('Relay func must invoke a contract');
  }
  const invocation = func.invokeContract();
  if (
    invocation.contractAddress().switch() !== xdr.ScAddressType.scAddressTypeContract() ||
    Address.fromScAddress(invocation.contractAddress()).toString() !== config.router
  ) {
    invalidParams('Relay target must be the configured Router contract');
  }
  const functionName = invocation.functionName().toString();
  const priced = functionName === ROUTER_WRAP_FUNCTIONS.fill || functionName === ROUTER_WRAP_FUNCTIONS['try-fill'];
  const args = invocation.args();
  if (
    (!priced && functionName !== ROUTER_WRAP_FUNCTIONS.calls) ||
    args.length !== (priced ? PRICED_ARGUMENTS : UNPRICED_ARGUMENTS)
  ) {
    invalidParams('Relay accepts only the Router *_with_fee entry points with their exact ABI');
  }

  const user = scAddress(args[ROUTER_SLOT.user]!, 'relay user');
  // Decode the signed batch: session-rule calls get the full structural policy
  // (session.ts) before the relay spends a simulation on them; everything else
  // passes through untouched — Soroban auth enforces it on-chain.
  const callsValue = args[ROUTER_SLOT.calls]!;
  if (callsValue.switch() !== xdr.ScValType.scvVec()) invalidParams('Relay calls must be a vector of Router Calls');
  const calls = (callsValue.vec() ?? []).map((value, index) => decodeRouterCall(value, `calls[${index}]`));
  const sessionExpiries = validateSessionRuleCalls(calls, user, config);
  const feeToken = scAddress(args[ROUTER_SLOT.feeToken]!, 'relay fee token');
  if (feeToken !== config.feeToken.contractId) {
    invalidParams('Relay fee token is not an enabled collateral token');
  }
  const maximumFeeValue = args[ROUTER_SLOT.maximumFee]!;
  if (maximumFeeValue.switch() !== xdr.ScValType.scvI128()) invalidParams('maximum relay fee must be an i128');
  const maximumFeeAtomic = scValToNative(maximumFeeValue) as bigint;
  // No expiration window here — submit rejects against the simulation receipt's live ledger.
  const feeExpirationValue = args[ROUTER_SLOT.feeExpiration]!;
  if (feeExpirationValue.switch() !== xdr.ScValType.scvU32()) invalidParams('relay fee expiration must be a u32');
  const feeExpiration = feeExpirationValue.u32();
  // The cap is the signer's choice; the relay enforces its computed fee against it after simulation.
  if (maximumFeeAtomic <= 0n) invalidParams('Relay fee envelope is outside configured bounds');

  // Client-supplied and structural only: a wrong feed selects a price the trading contract rejects at simulation.
  if (priced && request.feedId === undefined) {
    invalidParams('Priced relay func requires a feedId to select its market price');
  }

  return {
    priced,
    user,
    feeRateBps: config.feeToken.feeRateBps,
    maximumFeeAtomic,
    feeExpiration,
    feedId: priced ? (request.feedId ?? null) : null,
    // Non-empty expiries imply config.session — the structural pass above fails closed without it.
    sessionRules:
      sessionExpiries.length > 0
        ? { expiries: sessionExpiries, maxDurationLedgers: config.session!.maxDurationLedgers }
        : null,
    func,
    auth,
  };
}
