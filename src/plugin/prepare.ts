/**
 * prepare.ts
 *
 * Prepare pipeline: build the route's wrap (a Router `*_with_fee`, or in forwarder mode the fee
 * forwarder's `forward*` around the Router call), run one auth-discovery simulation, and return the
 * func, stamped user auth entries, and decoded outcome.
 */

import { Address, hash, scValToNative, xdr } from '@stellar/stellar-sdk';
import { pluginError, Relayer } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS, RELAY } from './constants';
import {
  authProjection,
  buildForwarderWrap,
  buildRouterWrap,
  decodeCallXdrs,
  invalidParams,
  parseCallOutcome,
  PLACEHOLDER_FEE_AMOUNT_ATOMIC,
} from './parse';
import { simulateDiscovery } from './simulation';
import {
  RelayParseConfig,
  RelayPrepareOutcome,
  RelayPreparedAuthEntry,
  RelayPrepareRequest,
  RelayMode,
  RelayPrepareResult,
  RelayPrepareRoute,
  RouterWrapPrefix,
} from './types';

/** sha256 over the sorobanAuthorization preimage; SEP-43 wallets recompute it from the entry XDR. */
function computePayloadHash(networkPassphrase: string, entry: xdr.SorobanAuthorizationEntry): string {
  const credentials = entry.credentials().address();
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase, 'utf8')),
      nonce: credentials.nonce(),
      signatureExpirationLedger: credentials.signatureExpirationLedger(),
      invocation: entry.rootInvocation(),
    })
  );
  return hash(preimage.toXDR('raw')).toString('hex');
}

// bigints -> decimal strings, bytes -> base64, maps -> objects, recursively.
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, entry]) => [String(key), jsonSafe(entry)]));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value ?? null;
}

/** The SDK's decoded outcome, made JSON-safe for the plugin envelope. */
function jsonOutcome(raw: xdr.ScVal): { ok: boolean; value: unknown; error: number } {
  const outcome = parseCallOutcome(raw);
  return { ok: outcome.ok, value: jsonSafe(outcome.value ?? null), error: outcome.error };
}

/**
 * Decode a discovery-sim `retval`: the Router's `Vec<Val>` (fill/try-fill append the fill outcome last),
 * which the forwarder returns as the target's value unchanged.
 */
function decodeOutcome(route: RelayPrepareRoute, retval: xdr.ScVal): RelayPrepareOutcome {
  const elements = [...(retval.vec() ?? [])];
  switch (route) {
    case 'calls':
      return { kind: 'callOutcomes', results: elements.map(jsonOutcome) };
    case 'fill':
      return { kind: 'fills', results: elements.map((element) => jsonSafe(scValToNative(element))) };
    case 'try-fill': {
      const outcomes = elements.map(jsonOutcome);
      const fill = outcomes[outcomes.length - 1];
      return { kind: fill?.ok ? 'fills' : 'rests', results: outcomes };
    }
  }
}

/** The auth projection the user signs, compared against each entry's root. */
function expectedRootFunctionHex(func: xdr.HostFunction, mode: RelayMode): string {
  const invocation = func.invokeContract();
  return xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: invocation.contractAddress(),
      functionName: invocation.functionName(),
      args: authProjection(func, mode),
    })
  ).toXDR('hex');
}

/**
 * The route's wrap exactly as the user will sign it. Router mode splices a placeholder recipient into
 * the unsigned tail (submit overwrites it). Forwarder mode signs the recipient, so the configured one
 * goes in now. Priced routes carry a real Data Streams report; keeper = user so the fill reward
 * round-trips.
 */
function buildPreparedWrap(
  route: RelayPrepareRoute,
  policy: RelayParseConfig,
  prefix: RouterWrapPrefix,
  market: Uint8Array | null
): xdr.HostFunction {
  // Submit prices the real fee off its own simulation and overwrites this placeholder.
  const priceTail = market === null ? {} : { keeper: prefix.user, priceUpdate: market };
  const tail = { feeAmountAtomic: PLACEHOLDER_FEE_AMOUNT_ATOMIC, ...priceTail };
  return policy.forwarder === undefined
    ? buildRouterWrap(policy.router, route, prefix, { ...tail, feeRecipient: prefix.user })
    : buildForwarderWrap(policy.router, policy.forwarder, route, prefix, tail);
}

export async function prepareRelayEntries(
  route: RelayPrepareRoute,
  request: RelayPrepareRequest,
  policy: RelayParseConfig,
  networkPassphrase: string,
  relayer: Relayer,
  sourceAccount: string,
  market: Uint8Array | null
): Promise<RelayPrepareResult> {
  const { user, expirationLedger } = request;
  const decoded = decodeCallXdrs(request.calls);

  const priced = route !== 'calls';
  if (route === 'fill' && decoded[0]!.func !== 'create_order') {
    invalidParams('Fill prepare requires the primary call to be create_order');
  }
  // The handler fetches a market update for every priced route; fail closed if that invariant breaks.
  if (priced && market === null) {
    throw pluginError('Priced prepare requires a market price update', {
      code: 'PRICE_UNAVAILABLE',
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
    });
  }

  const prefix = {
    calls: decoded,
    user,
    feeToken: policy.feeToken.contractId,
    maximumFeeAtomic: BigInt(request.maxFeeAmountAtomic),
    feeExpirationLedger: expirationLedger,
  };
  const func = buildPreparedWrap(route, policy, prefix, priced ? market : null);

  const simulation = await simulateDiscovery(func, sourceAccount, relayer, networkPassphrase);
  console.debug(`[zenex] Discovery: auth_count=${simulation.auth.length}, ledger=${simulation.ledger}`);

  // Refuse an expiration the chain would reach before inclusion.
  if (expirationLedger < simulation.ledger + RELAY.MIN_EXPIRATION_BUFFER_LEDGERS) {
    throw pluginError(
      `Requested expiration ledger must be at least ${RELAY.MIN_EXPIRATION_BUFFER_LEDGERS} ledgers ahead of the current ledger`,
      {
        code: 'EXPIRATION_TOO_CLOSE',
        status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
        details: {
          expirationLedger,
          latestLedger: simulation.ledger,
          minimumRequired: RELAY.MIN_EXPIRATION_BUFFER_LEDGERS,
        },
      }
    );
  }

  const expectedRoot = expectedRootFunctionHex(func, policy.forwarder === undefined ? 'router' : 'forwarder');
  const authEntries: RelayPreparedAuthEntry[] = [];
  for (const entry of simulation.auth) {
    // Source-account credentials are the relay's own; they never travel.
    if (entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) continue;
    const credentials = entry.credentials().address();
    const signer = Address.fromScAddress(credentials.address()).toString();
    if (signer !== user) {
      // A required signer the user cannot produce can never submit.
      invalidParams('Prepared invocation requires authorization from a signer other than the user', { signer });
    }
    if (entry.rootInvocation().function().toXDR('hex') !== expectedRoot) {
      // Rooted outside the wrap the relay built: fail closed.
      throw pluginError('Discovery simulation returned an auth entry for a different invocation than the relay built', {
        code: 'DISCOVERY_INVOCATION_MISMATCH',
        status: HTTP_STATUS.BAD_GATEWAY,
        details: { signer },
      });
    }
    // Discovery returns expiration 0; stamp the client's choice in place.
    credentials.signatureExpirationLedger(expirationLedger);
    authEntries.push({
      xdr: entry.toXDR('base64'),
      payloadHash: computePayloadHash(networkPassphrase, entry),
      signer,
      signatureExpirationLedger: expirationLedger,
    });
  }
  if (authEntries.length === 0) {
    throw pluginError('Prepared invocation requires no authorization entry from the user', {
      code: 'NO_AUTHORIZATION_REQUIRED',
      status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
    });
  }

  return {
    func: func.toXDR('base64'),
    authEntries,
    outcome: decodeOutcome(route, simulation.retval),
    feeTerms: {
      token: policy.feeToken.contractId,
      decimals: policy.feeToken.decimals,
      maximumAmount: request.maxFeeAmountAtomic,
      expirationLedger,
    },
  };
}
