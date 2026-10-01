/**
 * Shared fixtures for the zenex plugin tests: addresses, Router call XDRs, fee forwarder wraps,
 * auth-entry construction matching the args the user signs, and a fake Relayer over canned
 * simulateTransaction responses.
 */

import { Address, Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import type { Relayer } from '@openzeppelin/relayer-sdk';
import { buildWrap, decodeCallXdrs, PLACEHOLDER_FEE_AMOUNT_ATOMIC, signedArgs } from '../src/plugin/parse';
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
export const FORWARDER = StrKey.encodeContract(Buffer.alloc(32, 7));

/** `FORWARDER` wrapping `ROUTER`, paying `FEE_RECIPIENT` in `FEE_TOKEN`. */
export const PARSE_CONFIG: RelayParseConfig = {
  router: ROUTER,
  forwarder: FORWARDER,
  feeRecipient: FEE_RECIPIENT,
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

type WrapOptions = {
  calls?: string[];
  user?: string;
  expirationLedger?: number;
  maximumFeeAtomic?: bigint;
  market?: Uint8Array;
};

function wrapPrefix(route: RelayPrepareRoute, options: WrapOptions) {
  const calls = options.calls ?? [makeCallXdr(OTHER_CONTRACT, route === 'fill' ? 'create_order' : 'transfer')];
  return {
    calls: decodeCallXdrs(calls),
    user: options.user ?? USER,
    feeToken: FEE_TOKEN,
    maximumFeeAtomic: options.maximumFeeAtomic ?? 1_000_000n,
    feeExpirationLedger: options.expirationLedger ?? 1_000,
  };
}

/** The route's wrap exactly as prepare builds it (placeholder fee, the configured recipient, keeper = user). */
export function makeWrap(route: RelayPrepareRoute, options: WrapOptions = {}): xdr.HostFunction {
  const prefix = wrapPrefix(route, options);
  const tail = { feeAmountAtomic: PLACEHOLDER_FEE_AMOUNT_ATOMIC };
  return route === 'calls'
    ? buildWrap(PARSE_CONFIG, route, prefix, tail)
    : buildWrap(PARSE_CONFIG, route, prefix, {
        ...tail,
        keeper: prefix.user,
        priceUpdate: options.market ?? Uint8Array.from([1, 2, 3]),
      });
}

/** `func` with its outer arg at `slot` replaced — for tampering tests. */
export function withArg(func: xdr.HostFunction, slot: number, value: xdr.ScVal): xdr.HostFunction {
  const invocation = func.invokeContract();
  const args = invocation.args().slice();
  args[slot] = value;
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: invocation.contractAddress(),
      functionName: invocation.functionName(),
      args,
    })
  );
}

/**
 * An address-credentials auth entry rooted at the args the user signs for `func` — what a discovery
 * simulation returns for the user.
 */
export function makeAuthEntry(
  func: xdr.HostFunction,
  signer: string,
  options: { expiration?: number; rootArgs?: xdr.ScVal[] } = {}
): xdr.SorobanAuthorizationEntry {
  const invocation = func.invokeContract();
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
          args: options.rootArgs ?? signedArgs(func),
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

export interface FakeSimulation {
  auth?: xdr.SorobanAuthorizationEntry[];
  retval?: xdr.ScVal;
  latestLedger?: number;
  minResourceFee?: string;
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
        },
      };
    },
  };
  return relayer as unknown as Relayer;
}
