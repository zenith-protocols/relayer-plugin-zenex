/**
 * submit.ts
 *
 * Fee pricing and the single-simulation pass that builds the final call.
 */

import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { pluginError, Relayer } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS, RELAY } from './constants';
import { FORWARDER_SLOT, PLACEHOLDER_FEE_AMOUNT_ATOMIC, TARGET_SLOT } from './parse';
import { RelayPrices } from './pricing';
import { simulateFinal } from './simulation';
import { ParsedRelayCall } from './types';

/** The exact call handed to the embedded channels plugin. */
export type FinalCall = { func: xdr.HostFunction; auth: xdr.SorobanAuthorizationEntry[] };

/** The smallest fee the forwarder accepts: its OZ fee bounds reject `fee_amount == 0`. */
const MIN_FEE_ATOMIC = 1n;

// Stroops and the 7-decimal fee token share a scale, so the conversion is the USD price alone. Every
// magnitude here sits far below 2^53; ceil never undercharges a fractional unit.
function calculateRelayFee(costStroops: bigint, xlmUsd: number, feeRateBps: number): bigint {
  return BigInt(Math.ceil(Number(costStroops) * xlmUsd * (feeRateBps / 10_000)));
}

/**
 * Unconditionally overwrite the relay-owned parts so a crafted func cannot redirect a fee, reward, or
 * price: the fee, and a priced wrap's keeper and price inside `target_args`. The recipient is in the
 * user's signed args, which parse pinned to the configured one: it never changes here.
 */
function withRelayParts(parsed: ParsedRelayCall, feeAtomic: bigint, priceUpdate: Uint8Array | null): xdr.HostFunction {
  const invoke = parsed.func.invokeContract();
  const args = invoke.args().slice();
  args[FORWARDER_SLOT.feeAmount] = nativeToScVal(feeAtomic, { type: 'i128' });
  if (parsed.priced) {
    const targetArgs = (args[FORWARDER_SLOT.targetArgs]!.vec() ?? []).slice();
    // keeper = the func's own user slot: the fill reward round-trips.
    targetArgs[TARGET_SLOT.keeper] = args[FORWARDER_SLOT.user]!;
    targetArgs[TARGET_SLOT.priceUpdate] = xdr.ScVal.scvBytes(Buffer.from(priceUpdate!));
    args[FORWARDER_SLOT.targetArgs] = xdr.ScVal.scvVec(targetArgs);
  }
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: invoke.contractAddress(),
      functionName: invoke.functionName(),
      args,
    })
  );
}

/**
 * Build the final call from one simulation: the fee is a fixed-width i128,
 * so splicing its value cannot change the footprint.
 */
export async function prepareFinalCall(
  parsed: ParsedRelayCall,
  prices: RelayPrices,
  sourceAccount: string,
  relayer: Relayer,
  networkPassphrase: string
): Promise<FinalCall> {
  // fetchRelayPrices guarantees a market payload whenever the call is priced.
  const priceUpdate = prices.marketUpdate;

  const placeholder = withRelayParts(parsed, PLACEHOLDER_FEE_AMOUNT_ATOMIC, priceUpdate);
  const receipt = await simulateFinal(placeholder, parsed.auth, sourceAccount, relayer, networkPassphrase);

  // Refuse an already-expired call before it can burn a fund fee.
  if (parsed.feeExpiration < receipt.ledger + RELAY.MIN_EXPIRATION_BUFFER_LEDGERS) {
    throw pluginError(
      `Signed expiration ledger must be at least ${RELAY.MIN_EXPIRATION_BUFFER_LEDGERS} ledgers ahead of the current ledger`,
      {
        code: 'EXPIRATION_TOO_CLOSE',
        status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
        details: {
          feeExpiration: parsed.feeExpiration,
          latestLedger: receipt.ledger,
          minimumRequired: RELAY.MIN_EXPIRATION_BUFFER_LEDGERS,
        },
      }
    );
  }

  // The forwarder's fee bounds reject a zero fee, so a zero rate or price still charges one atomic unit.
  const computedFeeAtomic = calculateRelayFee(receipt.minResourceFeeStroops, prices.xlmUsd, parsed.feeRateBps);
  const feeAtomic = computedFeeAtomic < MIN_FEE_ATOMIC ? MIN_FEE_ATOMIC : computedFeeAtomic;
  if (feeAtomic > parsed.maximumFeeAtomic) {
    throw pluginError('Relay fee exceeds the user-signed maximum', {
      code: 'FEE_EXCEEDS_SIGNED_MAXIMUM',
      status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
      details: { feeAtomic: feeAtomic.toString(), maximumFeeAtomic: parsed.maximumFeeAtomic.toString() },
    });
  }
  console.debug(`[zenex] Fee: feeAtomic=${feeAtomic}, minResourceFee=${receipt.minResourceFeeStroops}`);

  return { func: withRelayParts(parsed, feeAtomic, priceUpdate), auth: parsed.auth };
}
