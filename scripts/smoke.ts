/*
 Zenex Plugin — Testnet Smoke Test

 What it does
 - Creates a throwaway friendbot-funded user
 - Prepares an XLM self-transfer through the Router's multicall_with_fee
 - Signs the returned auth entry and submits through the plugin
 - Polls the transaction until it lands and verifies it on Horizon

 Prerequisites
 - A running relayer with the zenex plugin (see README Installation & Setup)
 - The configured feeToken must be one the throwaway user can pay in — on
   testnet, point it at the native XLM SAC (see README) so any friendbot
   account passes the fee leg.

 Usage (inject API_KEY from your secret store or CI, keep it out of shell history)
   API_KEY=... npx tsx scripts/smoke.ts
   API_KEY=... npx tsx scripts/smoke.ts --base-url http://relayer:8080 --plugin-id zenex

 Flags / env (args > env > defaults; --api-key exists as a fallback to API_KEY)
   API_KEY (--api-key)       required: relayer API key
   RELAYER_URL (--base-url)  default: http://localhost:8080
   PLUGIN_ID (--plugin-id)   default: zenex
*/

import { Address, Asset, authorizeEntry, Keypair, nativeToScVal, Networks, xdr } from '@stellar/stellar-sdk';
import { ZenexClient } from '../src/client';

const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const EXPIRATION_LEDGER_OFFSET = 1_000;
const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1_000;

function flag(name: string, envName: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return process.env[envName] ?? fallback;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Router's `Call` ScMap (keys in sorted order); mirrors the plugin's encoder. */
function callToXdr(contract: string, func: string, args: xdr.ScVal[]): string {
  const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  return xdr.ScVal.scvMap([
    entry('args', xdr.ScVal.scvVec(args)),
    entry('contract', Address.fromString(contract).toScVal()),
    entry('func', xdr.ScVal.scvSymbol(func)),
  ])
    .toXDR('base64')
    .toString();
}

async function main(): Promise<void> {
  const apiKey = flag('api-key', 'API_KEY');
  if (!apiKey) fail('--api-key (or API_KEY) is required');
  const baseUrl = flag('base-url', 'RELAYER_URL', 'http://localhost:8080')!;
  const pluginId = flag('plugin-id', 'PLUGIN_ID', 'zenex')!;

  const client = new ZenexClient({ baseUrl, pluginId, apiKey });

  // 1. Throwaway user, friendbot-funded (fail fast if funding does not land).
  const user = Keypair.random();
  console.log('user:', user.publicKey());
  const funded = await fetch(`${FRIENDBOT_URL}?addr=${user.publicKey()}`);
  if (!funded.ok) fail(`friendbot funding failed: ${funded.status} ${await funded.text()}`);

  // 2. Anchor the signature expiration to the live ledger.
  const ledgers = (await (await fetch(`${HORIZON_URL}/ledgers?order=desc&limit=1`)).json()) as {
    _embedded: { records: { sequence: number }[] };
  };
  const expirationLedger = ledgers._embedded.records[0]!.sequence + EXPIRATION_LEDGER_OFFSET;

  // 3. Prepare an XLM self-transfer through multicall_with_fee.
  const prepared = await client.prepareCalls({
    user: user.publicKey(),
    calls: [
      callToXdr(Asset.native().contractId(Networks.TESTNET), 'transfer', [
        new Address(user.publicKey()).toScVal(),
        new Address(user.publicKey()).toScVal(),
        nativeToScVal(1n, { type: 'i128' }),
      ]),
    ],
    expirationLedger,
    maxFeeAmountAtomic: '1000000',
  });
  console.log('prepare ok — outcome:', JSON.stringify(prepared.outcome));

  // 4. Sign the returned auth entries as the user.
  const auth: string[] = [];
  for (const entry of prepared.authEntries) {
    const parsed = xdr.SorobanAuthorizationEntry.fromXDR(entry.xdr, 'base64');
    const signed = await authorizeEntry(parsed, user, entry.signatureExpirationLedger, Networks.TESTNET);
    auth.push(signed.toXDR('base64').toString());
  }

  // 5. Submit; channels answers immediately (skipWait), so poll for the hash.
  const submitted = await client.submit({ func: prepared.func, auth });
  console.log('submitted:', JSON.stringify(submitted));
  if (!submitted.transactionId) fail('submission returned no transactionId');

  let hash = submitted.hash;
  for (let attempt = 0; hash === null && attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    const status = await client.getTransaction({ transactionId: submitted.transactionId });
    hash = status.hash;
  }
  if (hash === null) fail(`no hash after ${POLL_ATTEMPTS}s of polling`);
  console.log('hash:', hash);

  // 6. Poll Horizon until the transaction is indexed, then verify it landed.
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const response = await fetch(`${HORIZON_URL}/transactions/${hash}`);
    if (response.ok) {
      const transaction = (await response.json()) as { successful?: boolean };
      if (transaction.successful === true) {
        console.log('on-chain: SUCCESS');
        return;
      }
      fail(`transaction landed but failed: ${JSON.stringify(transaction).slice(0, 300)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  fail(`transaction ${hash} not indexed on Horizon after ${POLL_ATTEMPTS}s`);
}

main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
