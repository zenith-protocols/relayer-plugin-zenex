/**
 * parse.ts
 *
 * Wire decoding and the Router and fee forwarder ABIs for the zenex relay plugin.
 */

import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { pluginError, Json } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS } from './constants';
import {
  Call,
  ForwarderPolicy,
  ForwarderWrapTail,
  ParsedRelayCall,
  RelayMode,
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

/**
 * The fee forwarder entry point and Router target each prepare route uses in forwarder mode. Only
 * `forward_unsafe` leaves `target_args` unsigned, so only the priced routes, whose keeper and price the
 * relay refreshes after signing, use it.
 */
const FORWARDER_ROUTES = {
  calls: { entry: 'forward', target: 'multicall' },
  'try-fill': { entry: 'forward_unsafe', target: 'create_and_try_fill' },
  fill: { entry: 'forward_unsafe', target: 'create_and_fill' },
} as const satisfies Record<RelayPrepareRoute, { entry: string; target: string }>;

/**
 * Argument slots of the fee forwarder's two entry points, fixed by its ABI:
 *   forward[_unsafe](fee_token, fee_amount, max_fee_amount, expiration_ledger,
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
 * Slots of the Router call inside a forwarder wrap's `target_args`:
 *   multicall(calls)                               — the calls route
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

/** The outer slots the forwarder's `forward_unsafe` authenticates, in its projection order. */
const FORWARD_UNSAFE_PROJECTION = [
  FORWARDER_SLOT.feeToken,
  FORWARDER_SLOT.maximumFee,
  FORWARDER_SLOT.feeExpiration,
  FORWARDER_SLOT.feeRecipient,
  FORWARDER_SLOT.targetContract,
  FORWARDER_SLOT.targetFunction,
];

/**
 * The outer slots each auth projection pins, in the order the contract authenticates them. The Router
 * `*_with_fee` wraps pin `(calls, fee_token, max_fee_amount, fee_expiration)`. The forwarder pins
 * `(fee_token, max_fee_amount, expiration_ledger, fee_recipient, target_contract, target_fn)`, and
 * `forward` adds `target_args`.
 */
const AUTH_PROJECTIONS = {
  router: [ROUTER_SLOT.calls, ROUTER_SLOT.feeToken, ROUTER_SLOT.maximumFee, ROUTER_SLOT.feeExpiration],
  forward: [...FORWARD_UNSAFE_PROJECTION, FORWARDER_SLOT.targetArgs],
  forward_unsafe: FORWARD_UNSAFE_PROJECTION,
} as const;

/** The outer args the user's root auth entry pins for `func`, in the contract's projection order. */
export function authProjection(func: xdr.HostFunction, mode: RelayMode): xdr.ScVal[] {
  const invocation = func.invokeContract();
  const args = invocation.args();
  const entry = invocation.functionName().toString();
  const slots =
    mode === 'router'
      ? AUTH_PROJECTIONS.router
      : entry === FORWARDER_ROUTES.calls.entry
        ? AUTH_PROJECTIONS.forward
        : AUTH_PROJECTIONS.forward_unsafe;
  return slots.map((slot) => args[slot]!);
}

/** The unsigned-tail fee placeholder; submit overwrites the whole tail with the converged fee. */
export const PLACEHOLDER_FEE_AMOUNT_ATOMIC = 1n;

function invokeContract(contract: string, functionName: string, args: xdr.ScVal[]): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(contract).toScAddress(),
      functionName,
      args,
    })
  );
}

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
  return invokeContract(router, ROUTER_WRAP_FUNCTIONS[route], args);
}

/**
 * Builds the route's fee forwarder outer host function per the `FORWARDER_SLOT` ABI: the Router call
 * goes in as `target_contract`/`target_fn`/`target_args` (`TARGET_SLOT`), and the recipient is the
 * policy's, which the user signs.
 */
export function buildForwarderWrap(
  router: string,
  forwarder: ForwarderPolicy,
  route: RelayPrepareRoute,
  prefix: RouterWrapPrefix,
  tail: ForwarderWrapTail
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
    Address.fromString(router).toScVal(),
    xdr.ScVal.scvSymbol(FORWARDER_ROUTES[route].target),
    xdr.ScVal.scvVec(targetArgs),
    Address.fromString(prefix.user).toScVal(),
    Address.fromString(forwarder.feeRecipient).toScVal(),
  ];
  return invokeContract(forwarder.contract, FORWARDER_ROUTES[route].entry, args);
}

/** Decodes the signed batch structurally; the calls themselves pass through untouched. */
function checkRouterCalls(value: xdr.ScVal): void {
  if (value.switch() !== xdr.ScValType.scvVec()) invalidParams('Relay calls must be a vector of Router Calls');
  (value.vec() ?? []).forEach((call, index) => decodeRouterCall(call, `calls[${index}]`));
}

/** The fee terms both ABIs carry: the configured token, a positive signed cap, and a u32 expiration. */
function parseFeeTerms(
  args: xdr.ScVal[],
  slots: { feeToken: number; maximumFee: number; feeExpiration: number },
  config: RelayParseConfig
): { maximumFeeAtomic: bigint; feeExpiration: number } {
  const feeToken = scAddress(args[slots.feeToken]!, 'relay fee token');
  if (feeToken !== config.feeToken.contractId) {
    invalidParams('Relay fee token is not an enabled collateral token');
  }
  const maximumFeeValue = args[slots.maximumFee]!;
  if (maximumFeeValue.switch() !== xdr.ScValType.scvI128()) invalidParams('maximum relay fee must be an i128');
  const maximumFeeAtomic = scValToNative(maximumFeeValue) as bigint;
  // No expiration window here — submit rejects against the simulation receipt's live ledger.
  const feeExpirationValue = args[slots.feeExpiration]!;
  if (feeExpirationValue.switch() !== xdr.ScValType.scvU32()) invalidParams('relay fee expiration must be a u32');
  const feeExpiration = feeExpirationValue.u32();
  // The cap is the signer's choice; the relay enforces its computed fee against it after simulation.
  if (maximumFeeAtomic <= 0n) invalidParams('Relay fee envelope is outside configured bounds');
  return { maximumFeeAtomic, feeExpiration };
}

/** Parses a decoded submit body under the configured mode's ABI policy. */
export function parseSubmitRequest(request: RelaySubmitRequest, config: RelayParseConfig): ParsedRelayCall {
  return config.forwarder === undefined
    ? parseRouterSubmit(request, config)
    : parseForwarderSubmit(request, config, config.forwarder);
}

// Router ABI policy over a decoded submit body; the signed entries pass through untouched — diverging
// entries fail the pre-handoff simulation via the Router's `require_auth_for_args`.
function parseRouterSubmit(request: RelaySubmitRequest, config: RelayParseConfig): ParsedRelayCall {
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
  // Decode the signed batch structurally; the calls themselves pass through
  // untouched — the user pays the relay fee, and Soroban auth enforces what
  // their signature grants on-chain.
  checkRouterCalls(args[ROUTER_SLOT.calls]!);
  const { maximumFeeAtomic, feeExpiration } = parseFeeTerms(args, ROUTER_SLOT, config);

  // Client-supplied and structural only: a wrong feed selects a price the trading contract rejects at simulation.
  if (priced && request.feedId === undefined) {
    invalidParams('Priced relay func requires a feedId to select its market price');
  }

  return {
    mode: 'router',
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

// Forwarder ABI policy over a decoded submit body. `forward_unsafe` leaves `target_args` unsigned, so
// the relay pins what it can check here — the Router target, its function, the batch shape, the fill
// user — and submit overwrites the rest (keeper, price). The recipient is signed: it must already be
// the configured one, since submit never rewrites it.
function parseForwarderSubmit(
  request: RelaySubmitRequest,
  config: RelayParseConfig,
  forwarder: ForwarderPolicy
): ParsedRelayCall {
  const { func, auth } = request;

  if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    invalidParams('Relay func must invoke a contract');
  }
  const invocation = func.invokeContract();
  if (
    invocation.contractAddress().switch() !== xdr.ScAddressType.scAddressTypeContract() ||
    Address.fromScAddress(invocation.contractAddress()).toString() !== forwarder.contract
  ) {
    invalidParams('Relay target must be the configured fee forwarder contract');
  }
  const entry = invocation.functionName().toString();
  const args = invocation.args();
  if (
    (entry !== FORWARDER_ROUTES.calls.entry && entry !== FORWARDER_ROUTES.fill.entry) ||
    args.length !== FORWARDER_ARGUMENTS
  ) {
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
  const route = (Object.keys(FORWARDER_ROUTES) as RelayPrepareRoute[]).find(
    (candidate) => FORWARDER_ROUTES[candidate].entry === entry && FORWARDER_ROUTES[candidate].target === targetFunction
  );
  if (route === undefined) {
    invalidParams('Relay forward target function does not match its forwarder entry point', {
      entry,
      targetFunction,
    });
  }
  const priced = route !== 'calls';

  const targetArgsValue = args[FORWARDER_SLOT.targetArgs]!;
  const targetArgs = targetArgsValue.switch() === xdr.ScValType.scvVec() ? (targetArgsValue.vec() ?? []) : null;
  if (targetArgs === null || targetArgs.length !== (priced ? PRICED_TARGET_ARGUMENTS : UNPRICED_TARGET_ARGUMENTS)) {
    invalidParams('Relay forward target args must match the Router function exactly');
  }
  checkRouterCalls(targetArgs[TARGET_SLOT.calls]!);
  // Unsigned under `forward_unsafe`: the fill must target the signer's own order.
  if (priced && scAddress(targetArgs[TARGET_SLOT.user]!, 'relay fill user') !== user) {
    invalidParams('Relay fill user must be the signing user');
  }

  const { maximumFeeAtomic, feeExpiration } = parseFeeTerms(args, FORWARDER_SLOT, config);
  if (scAddress(args[FORWARDER_SLOT.feeRecipient]!, 'relay fee recipient') !== forwarder.feeRecipient) {
    invalidParams('Relay fee recipient is not the configured recipient');
  }

  // Client-supplied and structural only: a wrong feed selects a price the trading contract rejects at simulation.
  if (priced && request.feedId === undefined) {
    invalidParams('Priced relay func requires a feedId to select its market price');
  }

  return {
    mode: 'forwarder',
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
