/**
 * submit.ts
 *
 * Fee pricing and the single-simulation pass that builds the final call.
 */

import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { pluginError, Relayer } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS, RELAY } from './constants';
import { PLACEHOLDER_FEE_AMOUNT_ATOMIC, ROUTER_SLOT } from './parse';
import { validateSessionRuleExpiries } from './session';
import { RelayPrices } from './pricing';
import { simulateFinal } from './simulation';
import { ParsedRelayCall } from './types';

/** The exact call handed to the embedded channels plugin. */
export type FinalCall = { func: xdr.HostFunction; auth: xdr.SorobanAuthorizationEntry[] };

// Stroops and the 7-decimal fee token share a scale, so the conversion is the USD price alone. Every
// magnitude here sits far below 2^53; ceil never undercharges a fractional unit.
function calculateRelayFee(costStroops: bigint, xlmUsd: number, feeRateBps: number): bigint {
  return BigInt(Math.ceil(Number(costStroops) * xlmUsd * (feeRateBps / 10_000)));
}

/** Unconditionally overwrite the relay-owned tail so a crafted tail cannot redirect a fee, reward, or price. */
function withTail(
  parsed: ParsedRelayCall,
  feeAtomic: bigint,
  feeRecipient: string,
  priceUpdate: Uint8Array | null
): xdr.HostFunction {
  const invoke = parsed.func.invokeContract();
  const args = invoke.args().slice();
  args[ROUTER_SLOT.feeAmount] = nativeToScVal(feeAtomic, { type: 'i128' });
  args[ROUTER_SLOT.feeRecipient] = Address.fromString(feeRecipient).toScVal();
  if (parsed.priced) {
    // keeper = the func's own user slot: the fill reward round-trips.
    args[ROUTER_SLOT.keeper] = args[ROUTER_SLOT.user]!;
    args[ROUTER_SLOT.priceUpdate] = xdr.ScVal.scvBytes(Buffer.from(priceUpdate!));
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
  feeRecipient: string,
  prices: RelayPrices,
  sourceAccount: string,
  relayer: Relayer,
  networkPassphrase: string
): Promise<FinalCall> {
  // fetchRelayPrices guarantees a market payload whenever the call is priced.
  const priceUpdate = prices.marketUpdate;

  const placeholder = withTail(parsed, PLACEHOLDER_FEE_AMOUNT_ATOMIC, feeRecipient, priceUpdate);
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
  // The signed batch's session rules (parse.ts) must expire inside the configured window from the live ledger.
  if (parsed.sessionRules !== null) {
    validateSessionRuleExpiries(parsed.sessionRules.expiries, receipt.ledger, parsed.sessionRules.maxDurationLedgers);
  }

  const feeAtomic = calculateRelayFee(receipt.minResourceFeeStroops, prices.xlmUsd, parsed.feeRateBps);
  if (feeAtomic > parsed.maximumFeeAtomic) {
    throw pluginError('Relay fee exceeds the user-signed maximum', {
      code: 'FEE_EXCEEDS_SIGNED_MAXIMUM',
      status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
      details: { feeAtomic: feeAtomic.toString(), maximumFeeAtomic: parsed.maximumFeeAtomic.toString() },
    });
  }
  console.debug(`[zenex] Fee: feeAtomic=${feeAtomic}, minResourceFee=${receipt.minResourceFeeStroops}`);

  return { func: withTail(parsed, feeAtomic, feeRecipient, priceUpdate), auth: parsed.auth };
}
