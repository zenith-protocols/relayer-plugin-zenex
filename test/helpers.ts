/**
 * Shared fixtures for the zenex plugin tests: addresses, Router call XDRs,
 * auth-entry construction matching the relay's auth projection, and a fake
 * Relayer over canned simulateTransaction responses.
 */

import { Address, Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import type { Relayer } from '@openzeppelin/relayer-sdk';
import { buildRouterWrap, decodeCallXdrs, PLACEHOLDER_FEE_AMOUNT_ATOMIC } from '../src/plugin/parse';
import type { RelayParseConfig, RelayPrepareRoute } from '../src/plugin/types';

/** The live XLM/USD Data Streams feed id (the oracle contracts' test vector). */
export const XLM_FEED_ID = '0x000358cb12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a';
/** A second, distinct V3-shaped feed id for market-vs-XLM tests. */
export const MARKET_FEED_ID = '0x0003aaaa12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a';

export const ROUTER = StrKey.encodeContract(Buffer.alloc(32, 1));
export const FEE_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 2));
export const OTHER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3));
export const USER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey();
export const SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)).publicKey();
export const FEE_RECIPIENT = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 6)).publicKey();

export const PARSE_CONFIG: RelayParseConfig = {
  router: ROUTER,
  feeToken: { contractId: FEE_TOKEN, decimals: 7, feeRateBps: 30 },
};

/** One Router `Call` ScMap (keys in sorted order), base64-encoded. */
export function makeCallXdr(contract: string, func: string, args: xdr.ScVal[] = []): string {
  const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  return xdr.ScVal.scvMap([
    entry('args', xdr.ScVal.scvVec(args)),
    entry('contract', Address.fromString(contract).toScVal()),
    entry('func', xdr.ScVal.scvSymbol(func)),
  ])
    .toXDR('base64')
    .toString();
}

/** The route's Router wrap exactly as prepare builds it (placeholder tail, keeper = user). */
export function makeWrap(
  route: RelayPrepareRoute,
  options: {
    calls?: string[];
    user?: string;
    expirationLedger?: number;
    maximumFeeAtomic?: bigint;
    market?: Uint8Array;
  } = {}
): xdr.HostFunction {
  const user = options.user ?? USER;
  const calls = options.calls ?? [makeCallXdr(OTHER_CONTRACT, route === 'fill' ? 'create_order' : 'transfer')];
  const prefix = {
    calls: decodeCallXdrs(calls),
    user,
    feeToken: FEE_TOKEN,
    maximumFeeAtomic: options.maximumFeeAtomic ?? 1_000_000n,
    feeExpirationLedger: options.expirationLedger ?? 1_000,
  };
  const tail = { feeAmountAtomic: PLACEHOLDER_FEE_AMOUNT_ATOMIC, feeRecipient: user };
  return route === 'calls'
    ? buildRouterWrap(ROUTER, route, prefix, tail)
    : buildRouterWrap(ROUTER, route, prefix, {
        ...tail,
        keeper: user,
        priceUpdate: options.market ?? Uint8Array.from([1, 2, 3]),
      });
}

/**
 * An address-credentials auth entry rooted at the relay's auth projection of
 * `func` (outer args 0/2/3/4) — what a discovery simulation returns for the user.
 */
export function makeAuthEntry(
  func: xdr.HostFunction,
  signer: string,
  options: { expiration?: number; rootArgs?: xdr.ScVal[] } = {}
): xdr.SorobanAuthorizationEntry {
  const invocation = func.invokeContract();
  const args = invocation.args();
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(signer).toScAddress(),
        nonce: new xdr.Int64(0),
        signatureExpirationLedger: options.expiration ?? 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: invocation.contractAddress(),
          functionName: invocation.functionName(),
          args: options.rootArgs ?? [args[0]!, args[2]!, args[3]!, args[4]!],
        })
      ),
      subInvocations: [],
    }),
  });
}

/** A source-account credentials entry — the relay's own, never returned to the user. */
export function makeSourceAccountEntry(func: xdr.HostFunction): xdr.SorobanAuthorizationEntry {
  const invocation = func.invokeContract();
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: invocation.contractAddress(),
          functionName: invocation.functionName(),
          args: [],
        })
      ),
      subInvocations: [],
    }),
  });
}

/** A `SorobanTransactionData` over an empty footprint at the given resource sizes, base64-encoded. */
export function makeTransactionData(resources: {
  instructions: number;
  diskReadBytes: number;
  writeBytes: number;
  resourceFee: string;
}): string {
  return new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(0),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
      instructions: resources.instructions,
      diskReadBytes: resources.diskReadBytes,
      writeBytes: resources.writeBytes,
    }),
    resourceFee: xdr.Int64.fromString(resources.resourceFee),
  })
    .toXDR('base64')
    .toString();
}

export interface FakeSimulation {
  auth?: xdr.SorobanAuthorizationEntry[];
  retval?: xdr.ScVal;
  latestLedger?: number;
  minResourceFee?: string;
  transactionData?: string;
  error?: string;
}

/** A fake Relayer whose rpc() answers simulateTransaction with the canned result per authMode. */
export function makeFakeRelayer(byAuthMode: Partial<Record<'record' | 'enforce', FakeSimulation>>): Relayer {
  const calls: unknown[] = [];
  const relayer = {
    calls,
    async rpc(payload: { params: { authMode: 'record' | 'enforce' } }) {
      calls.push(payload);
      const sim = byAuthMode[payload.params.authMode];
      if (!sim) throw new Error(`no fake simulation for authMode ${payload.params.authMode}`);
      if (sim.error) {
        return { jsonrpc: '2.0', id: 1, result: { error: sim.error, latestLedger: sim.latestLedger ?? 100 } };
      }
      return {
        jsonrpc: '2.0',
        id: 1,
        result: {
          results: [
            {
              xdr: (sim.retval ?? xdr.ScVal.scvVec([])).toXDR('base64'),
              auth: (sim.auth ?? []).map((entry) => entry.toXDR('base64')),
            },
          ],
          latestLedger: sim.latestLedger ?? 100,
          minResourceFee: sim.minResourceFee ?? '1000000',
          ...(sim.transactionData ? { transactionData: sim.transactionData } : {}),
        },
      };
    },
  };
  return relayer as unknown as Relayer;
}
