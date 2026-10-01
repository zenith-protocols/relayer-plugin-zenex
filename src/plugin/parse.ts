/**
 * parse.ts
 *
 * Wire decoding and the fee forwarder ABI (wrapping the Router) for the zenex relay plugin.
 */

import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { pluginError, Json } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS } from './constants';
import {
  Call,
  ParsedRelayCall,
  RelayParseConfig,
  RelayPrepareRoute,
  RelaySubmitRequest,
  WrapPrefix,
  WrapTail,
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

/**
 * The fee forwarder entry point and Router target of each prepare route. `forward` signs `target_args`
 * (the batch); `forward_dynamic` leaves them unsigned, so the priced routes, whose keeper and price the
 * relay refreshes after signing, use it.
 */
const ROUTES = {
  calls: { entry: 'forward', target: 'multicall' },
  'try-fill': { entry: 'forward_dynamic', target: 'create_and_try_fill' },
  fill: { entry: 'forward_dynamic', target: 'create_and_fill' },
} as const satisfies Record<RelayPrepareRoute, { entry: string; target: string }>;

/**
 * Argument slots of the fee forwarder's two entry points, fixed by its ABI:
 *   forward[_dynamic](fee_token, fee_amount, max_fee_amount, expiration_ledger,
 *                    target_contract, target_fn, target_args, user, fee_recipient)
 */
export const FORWARDER_SLOT = {
  feeToken: 0,
  feeAmount: 1,
  maximumFee: 2,
  feeExpiration: 3,
  targetContract: 4,
  targetFunction: 5,
  targetArgs: 6,
  user: 7,
  feeRecipient: 8,
} as const;

const FORWARDER_ARGUMENTS = FORWARDER_SLOT.feeRecipient + 1;

/**
 * Slots of the Router call inside `target_args`:
 *   multicall(calls)                                  — the calls route
 *   create_and_[try_]fill(calls, user, keeper, price) — the priced routes
 */
export const TARGET_SLOT = {
  calls: 0,
  user: 1,
  keeper: 2,
  priceUpdate: 3,
} as const;

const UNPRICED_TARGET_ARGUMENTS = TARGET_SLOT.calls + 1;
const PRICED_TARGET_ARGUMENTS = TARGET_SLOT.priceUpdate + 1;

/** The outer slots `forward_dynamic` signs, in the forwarder's order; `forward` adds `target_args`. */
const SIGNED_SLOTS = [
  FORWARDER_SLOT.feeToken,
  FORWARDER_SLOT.maximumFee,
  FORWARDER_SLOT.feeExpiration,
  FORWARDER_SLOT.feeRecipient,
  FORWARDER_SLOT.targetContract,
  FORWARDER_SLOT.targetFunction,
];

/** The outer args the user's root auth entry signs for `func`, in the forwarder's order. */
export function signedArgs(func: xdr.HostFunction): xdr.ScVal[] {
  const invocation = func.invokeContract();
  const args = invocation.args();
  const slots =
    invocation.functionName().toString() === ROUTES.calls.entry
      ? [...SIGNED_SLOTS, FORWARDER_SLOT.targetArgs]
      : SIGNED_SLOTS;
  return slots.map((slot) => args[slot]!);
}

/** The prepared fee; submit overwrites it with the fee priced off its own simulation. */
export const PLACEHOLDER_FEE_AMOUNT_ATOMIC = 1n;

/**
 * Builds the route's fee forwarder call per `FORWARDER_SLOT`: the Router call goes in as
 * `target_contract`/`target_fn`/`target_args` (`TARGET_SLOT`), with the configured recipient, which the
 * user signs.
 */
export function buildWrap(
  config: RelayParseConfig,
  route: RelayPrepareRoute,
  prefix: WrapPrefix,
  tail: WrapTail
): xdr.HostFunction {
  const targetArgs = [xdr.ScVal.scvVec(prefix.calls.map(callToScVal))];
  if (route !== 'calls') {
    targetArgs.push(
      Address.fromString(prefix.user).toScVal(),
      Address.fromString(tail.keeper!).toScVal(),
      xdr.ScVal.scvBytes(Buffer.from(tail.priceUpdate!))
    );
  }
  const args = [
    Address.fromString(prefix.feeToken).toScVal(),
    nativeToScVal(tail.feeAmountAtomic, { type: 'i128' }),
    nativeToScVal(prefix.maximumFeeAtomic, { type: 'i128' }),
    xdr.ScVal.scvU32(prefix.feeExpirationLedger),
    Address.fromString(config.router).toScVal(),
    xdr.ScVal.scvSymbol(ROUTES[route].target),
    xdr.ScVal.scvVec(targetArgs),
    Address.fromString(prefix.user).toScVal(),
    Address.fromString(config.feeRecipient).toScVal(),
  ];
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(config.forwarder).toScAddress(),
      functionName: ROUTES[route].entry,
      args,
    })
  );
}

// Forwarder ABI policy over a decoded submit body. The signed entries pass through untouched — diverging
// entries fail the pre-handoff simulation via the forwarder's `require_auth_for_args`. `forward_dynamic`
// leaves `target_args` unsigned, so the relay pins what it can check here — the Router target, its
// function, the batch shape, the fill user — and submit overwrites the rest (keeper, price). The recipient
// is signed: it must already be the configured one, since submit never rewrites it.
export function parseSubmitRequest(request: RelaySubmitRequest, config: RelayParseConfig): ParsedRelayCall {
  const { func, auth } = request;

  if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    invalidParams('Relay func must invoke a contract');
  }
  const invocation = func.invokeContract();
  if (
    invocation.contractAddress().switch() !== xdr.ScAddressType.scAddressTypeContract() ||
    Address.fromScAddress(invocation.contractAddress()).toString() !== config.forwarder
  ) {
    invalidParams('Relay target must be the configured fee forwarder contract');
  }
  const entry = invocation.functionName().toString();
  const args = invocation.args();
  if ((entry !== ROUTES.calls.entry && entry !== ROUTES.fill.entry) || args.length !== FORWARDER_ARGUMENTS) {
    invalidParams('Relay accepts only the fee forwarder forward entry points with their exact ABI');
  }

  const user = scAddress(args[FORWARDER_SLOT.user]!, 'relay user');
  if (scAddress(args[FORWARDER_SLOT.targetContract]!, 'relay forward target') !== config.router) {
    invalidParams('Relay forward target must be the configured Router contract');
  }
  const targetFunctionValue = args[FORWARDER_SLOT.targetFunction]!;
  if (targetFunctionValue.switch() !== xdr.ScValType.scvSymbol()) {
    invalidParams('Relay forward target function must be a symbol');
  }
  const targetFunction = targetFunctionValue.sym().toString();
  const route = (Object.keys(ROUTES) as RelayPrepareRoute[]).find(
    (candidate) => ROUTES[candidate].entry === entry && ROUTES[candidate].target === targetFunction
  );
  if (route === undefined) {
    invalidParams('Relay forward target function does not match its forwarder entry point', { entry, targetFunction });
  }
  const priced = route !== 'calls';

  const targetArgsValue = args[FORWARDER_SLOT.targetArgs]!;
  const targetArgs = targetArgsValue.switch() === xdr.ScValType.scvVec() ? (targetArgsValue.vec() ?? []) : null;
  if (targetArgs === null || targetArgs.length !== (priced ? PRICED_TARGET_ARGUMENTS : UNPRICED_TARGET_ARGUMENTS)) {
    invalidParams('Relay forward target args must match the Router function exactly');
  }
  // Decode the batch structurally; the calls themselves pass through untouched — the user pays the relay
  // fee, and Soroban auth enforces what their signature grants on-chain.
  const callsValue = targetArgs[TARGET_SLOT.calls]!;
  if (callsValue.switch() !== xdr.ScValType.scvVec()) invalidParams('Relay calls must be a vector of Router Calls');
  (callsValue.vec() ?? []).forEach((value, index) => decodeRouterCall(value, `calls[${index}]`));
  // Unsigned under `forward_dynamic`: the fill must target the signer's own order.
  if (priced && scAddress(targetArgs[TARGET_SLOT.user]!, 'relay fill user') !== user) {
    invalidParams('Relay fill user must be the signing user');
  }

  const feeToken = scAddress(args[FORWARDER_SLOT.feeToken]!, 'relay fee token');
  if (feeToken !== config.feeToken.contractId) {
    invalidParams('Relay fee token is not an enabled collateral token');
  }
  const maximumFeeValue = args[FORWARDER_SLOT.maximumFee]!;
  if (maximumFeeValue.switch() !== xdr.ScValType.scvI128()) invalidParams('maximum relay fee must be an i128');
  const maximumFeeAtomic = scValToNative(maximumFeeValue) as bigint;
  // No expiration window here — submit rejects against the simulation receipt's live ledger.
  const feeExpirationValue = args[FORWARDER_SLOT.feeExpiration]!;
  if (feeExpirationValue.switch() !== xdr.ScValType.scvU32()) invalidParams('relay fee expiration must be a u32');
  const feeExpiration = feeExpirationValue.u32();
  // The cap is the signer's choice; the relay enforces its computed fee against it after simulation.
  if (maximumFeeAtomic <= 0n) invalidParams('Relay fee envelope is outside configured bounds');
  if (scAddress(args[FORWARDER_SLOT.feeRecipient]!, 'relay fee recipient') !== config.feeRecipient) {
    invalidParams('Relay fee recipient is not the configured recipient');
  }

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
    func,
    auth,
  };
}
