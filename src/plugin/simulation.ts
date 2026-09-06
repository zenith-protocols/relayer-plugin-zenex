/**
 * simulation.ts
 *
 * Simulate a Soroban transaction over the fund relayer's JSON-RPC passthrough
 * (auth discovery in record mode, final-call validation in enforce mode). The
 * parsed diagnostic travels to the caller, who owns decoding
 * `Error(Contract, #N)` via the zenex SDK — the plugin decodes nothing.
 *
 * This module also owns the resource margin. `withResourceMargin` wraps the
 * relayer API, so every `simulateTransaction` answer that reaches the fee
 * pricing and the channel assembly already carries the margin.
 */

import { Account, Operation, rpc, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { JsonRpcResponseNetworkRpcResult, PluginAPI, pluginError, Relayer } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS, RESOURCE_MARGIN, SIMULATION, TIME } from './constants';

/** An auth-discovery answer: required auth entries, decoded retval, ledger. */
export interface DiscoverySimulation {
  auth: xdr.SorobanAuthorizationEntry[];
  retval: xdr.ScVal;
  ledger: number;
}

export interface SimulationReceipt {
  ledger: number;
  minResourceFeeStroops: bigint;
}

interface SimulationFailure {
  code: string;
  message: string;
}

/** Extract human-readable message + error type from simulation error diagnostic events */
function parseSimulationError(error: string): string {
  const firstLine = error.split('\n')[0]?.trim() || 'Simulation failed';
  const errorType = firstLine.match(/Error\(([^)]+)\)/)?.[1];
  const arrayMatch = error.match(/data:\s*\["((?:[^"\\]|\\.)*)"/);
  if (arrayMatch?.[1] && arrayMatch[1].length > 3) {
    return errorType ? `${arrayMatch[1]} (${errorType})` : arrayMatch[1];
  }
  const stringMatch = error.match(/data:\s*"((?:[^"\\]|\\.)*)"/);
  if (stringMatch?.[1] && stringMatch[1].length > 3) {
    return errorType ? `${stringMatch[1]} (${errorType})` : stringMatch[1];
  }
  return firstLine;
}

function classifySimulationFailure(rawError: string, parsedError: string, authMode: string): SimulationFailure {
  const isEnforcedAuthValidation =
    authMode === 'enforce' &&
    (/\bError\(Auth,/i.test(rawError) ||
      /\brequire_auth\b/i.test(rawError) ||
      /\binvalid\s+signature\b/i.test(rawError) ||
      /\bsignature\s+has\s+expired\b/i.test(rawError) ||
      /\bsignature\s+expired\b/i.test(rawError) ||
      /\bsignature\s+verification\s+failed\b/i.test(rawError) ||
      /\bbad[_\s]?signature\b/i.test(rawError) ||
      /\btx_bad_auth\b/i.test(rawError) ||
      /\bbad[_\s]?auth\b/i.test(rawError));

  if (isEnforcedAuthValidation) {
    return {
      code: 'SIMULATION_SIGNED_AUTH_VALIDATION_FAILED',
      message: `Signed auth entry validation failed in enforce simulation: ${parsedError}`,
    };
  }

  return {
    code: 'SIMULATION_FAILED',
    message: 'Simulation failed',
  };
}

/**
 * Simulate `func` (+ optional auth) from a throwaway source account (sequence
 * "0") — `simulateTransaction` does not validate sequence numbers.
 */
async function simulateTransaction(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[] | undefined,
  sourceAddress: string,
  relayer: Relayer,
  networkPassphrase: string,
  authMode: 'record' | 'enforce'
): Promise<rpc.Api.RawSimulateTransactionResponse> {
  const now = Math.floor(Date.now() / 1000);
  const transaction = new TransactionBuilder(new Account(sourceAddress, '0'), {
    fee: SIMULATION.DEFAULT_FEE,
    networkPassphrase,
    timebounds: { minTime: TIME.MIN_TIME_BOUND, maxTime: now + TIME.MAX_TIME_BOUND_OFFSET_SECONDS },
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .build();

  let rpcResponse: JsonRpcResponseNetworkRpcResult;
  try {
    rpcResponse = await relayer.rpc({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e8).toString(),
      method: 'simulateTransaction',
      params: { transaction: transaction.toXDR(), authMode },
    });
  } catch (err) {
    throw pluginError('Simulation network request failed', {
      code: 'SIMULATION_NETWORK_ERROR',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { message: err instanceof Error ? err.message : String(err) },
    });
  }
  if (rpcResponse.error) {
    const { code, message, description, data } = rpcResponse.error as {
      code?: unknown;
      message?: unknown;
      description?: unknown;
      data?: unknown;
    };
    console.error(`[zenex] RPC error: code=${code}, message=${message}, detail=${description || data}`);
    throw pluginError('Simulation RPC failed', {
      code: 'SIMULATION_RPC_FAILURE',
      status: HTTP_STATUS.BAD_GATEWAY,
      details: { message: 'RPC provider error' },
    });
  }
  const simResult = {
    id: String(rpcResponse.id ?? '1'),
    ...(rpcResponse.result as object),
  } as rpc.Api.RawSimulateTransactionResponse;

  if ('error' in simResult && simResult.error) {
    const parsedError = parseSimulationError(simResult.error);
    const failure = classifySimulationFailure(simResult.error, parsedError, authMode);
    console.error(`[zenex] Simulation error: ${simResult.error}`);
    throw pluginError(failure.message, {
      code: failure.code,
      status: HTTP_STATUS.BAD_REQUEST,
      details: { error: parsedError, authMode },
    });
  }
  return simResult;
}

/** Auth-discovery (record mode): required auth entries + decoded retval. */
export async function simulateDiscovery(
  func: xdr.HostFunction,
  sourceAddress: string,
  relayer: Relayer,
  networkPassphrase: string
): Promise<DiscoverySimulation> {
  const simResult = await simulateTransaction(func, undefined, sourceAddress, relayer, networkPassphrase, 'record');
  const result = simResult.results?.[0];
  if (!result?.xdr || !simResult.latestLedger) {
    throw pluginError('Simulation response missing result xdr or latestLedger', {
      code: 'SIMULATION_INVALID_RESPONSE',
      status: HTTP_STATUS.BAD_GATEWAY,
    });
  }
  return {
    auth: (result.auth ?? []).map((entry) => xdr.SorobanAuthorizationEntry.fromXDR(entry, 'base64')),
    retval: xdr.ScVal.fromXDR(result.xdr, 'base64'),
    ledger: simResult.latestLedger,
  };
}

/** Final-call validation (enforce mode): ledger + resource fee receipt. */
export async function simulateFinal(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
  sourceAddress: string,
  relayer: Relayer,
  networkPassphrase: string
): Promise<SimulationReceipt> {
  const simResult = await simulateTransaction(func, auth, sourceAddress, relayer, networkPassphrase, 'enforce');
  if (!simResult.minResourceFee || !simResult.latestLedger) {
    throw pluginError('Simulation response missing minResourceFee or latestLedger', {
      code: 'SIMULATION_INVALID_RESPONSE',
      status: HTTP_STATUS.BAD_GATEWAY,
    });
  }
  return {
    ledger: simResult.latestLedger,
    minResourceFeeStroops: BigInt(simResult.minResourceFee),
  };
}

/**
 * Grow one byte dimension by the margin ratio or the byte floor, whichever is
 * larger, up to the ledger cap for that dimension. A simulation that already
 * sits at or above the cap keeps its own count.
 */
function marginedBytes(value: number, limit: number): number {
  const grown = value + Math.max(Math.ceil(value * RESOURCE_MARGIN.RATIO), RESOURCE_MARGIN.MIN_BYTES);
  return Math.max(value, Math.min(grown, limit));
}

/**
 * Grow the instruction count by the margin ratio, up to the ledger cap.
 * Instructions carry no absolute floor. A simulation that already sits at the
 * cap keeps its own count.
 */
function marginedInstructions(value: number): number {
  return Math.max(value, Math.min(value + Math.ceil(value * RESOURCE_MARGIN.RATIO), RESOURCE_MARGIN.MAX_INSTRUCTIONS));
}

/** How much one dimension grew. A dimension that simulated as zero grew by nothing. */
function growthFactor(after: number, before: number): number {
  return before > 0 ? after / before : 1;
}

/** Scale a stroop amount by a factor, rounded up, at millifactor precision. */
function scaleUp(amount: bigint, factor: number): bigint {
  const milli = BigInt(Math.ceil(factor * 1000));
  return (amount * milli + 999n) / 1000n;
}

/**
 * Raise the simulated resources of one `simulateTransaction` result by the margin.
 *
 * The resource fee grows by the largest growth factor of the three dimensions,
 * so the declared fee pays for whatever the margin added. A footprint the caps
 * clamp keeps its own fee. `minResourceFee` and
 * the `transactionData` resource fee stay equal, which is what the assembly and
 * the fee bump both read. A result without `transactionData` passes through.
 */
export function applyResourceMargin(
  result: rpc.Api.RawSimulateTransactionResponse
): rpc.Api.RawSimulateTransactionResponse {
  if (!result.transactionData || !result.minResourceFee) return result;

  let data: xdr.SorobanTransactionData;
  try {
    data = xdr.SorobanTransactionData.fromXDR(result.transactionData, 'base64');
  } catch {
    // An unparseable footprint is the assembly's failure to report, not this one's.
    return result;
  }

  const resources = data.resources();
  const instructions = resources.instructions();
  const diskReadBytes = resources.diskReadBytes();
  const writeBytes = resources.writeBytes();

  resources.instructions(marginedInstructions(instructions));
  resources.diskReadBytes(marginedBytes(diskReadBytes, RESOURCE_MARGIN.MAX_DISK_READ_BYTES));
  resources.writeBytes(marginedBytes(writeBytes, RESOURCE_MARGIN.MAX_WRITE_BYTES));

  const growth = Math.max(
    growthFactor(resources.instructions(), instructions),
    growthFactor(resources.diskReadBytes(), diskReadBytes),
    growthFactor(resources.writeBytes(), writeBytes)
  );
  const resourceFee = scaleUp(BigInt(result.minResourceFee), growth);
  data.resourceFee(xdr.Int64.fromString(resourceFee.toString()));

  return {
    ...result,
    transactionData: data.toXDR('base64'),
    minResourceFee: resourceFee.toString(),
  };
}

/** True when the payload asks the RPC node to simulate a transaction. */
function isSimulateRequest(payload: { method?: string }): boolean {
  return payload.method === 'simulateTransaction';
}

/**
 * Wrap the relayer API so every simulation answer carries the resource margin.
 *
 * The margin has one seam: the JSON-RPC passthrough that both this plugin and
 * the embedded channels handler simulate over. Padding the answer there sizes
 * the fee this plugin charges and the resources the assembled transaction
 * declares from one number.
 */
export function withResourceMargin(api: PluginAPI): PluginAPI {
  return new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'useRelayer' || typeof value !== 'function') return value;
      return (relayerId: string): Relayer => marginedRelayer(api.useRelayer(relayerId));
    },
  });
}

/** The relayer with its `simulateTransaction` answers margined. Every other method passes through. */
function marginedRelayer(relayer: Relayer): Relayer {
  return new Proxy(relayer, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'rpc' || typeof value !== 'function') return value;
      return async (payload: Parameters<Relayer['rpc']>[0]): Promise<JsonRpcResponseNetworkRpcResult> => {
        const response = await relayer.rpc(payload);
        if (!isSimulateRequest(payload) || response.error || !response.result) return response;
        const margined = applyResourceMargin(response.result as rpc.Api.RawSimulateTransactionResponse);
        return { ...response, result: margined } as JsonRpcResponseNetworkRpcResult;
      };
    },
  });
}
