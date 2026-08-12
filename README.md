# @zenith-protocols/relayer-plugin-zenex

OpenZeppelin Relayer plugin for the Zenex transaction relay. It prepares and
submits router transactions (auth discovery, Chainlink Data Streams report
injection, fee enforcement) and delegates final submission to the embedded
`@openzeppelin/relayer-plugin-channels` handler in-process. The package also
ships `ZenexClient`, a typed client for the plugin's routes.

```bash
npm install @zenith-protocols/relayer-plugin-zenex
```

## Prerequisites

- Node.js >= 20.19
- An OpenZeppelin Relayer deployment (v1.4.0+) with Redis, a Stellar network
  config, and local signers for the fund and channel accounts
- Chainlink Data Streams credentials (the portal's user ID and HMAC secret)
  with access to the feeds you serve

## Installation & Setup

The zenex plugin can be added to any OpenZeppelin Relayer in two ways:

### 1. Install from npm (recommended)

```bash
# From the root of your Relayer repository
cd plugins
mkdir zenex
cd zenex
npm install @zenith-protocols/relayer-plugin-zenex
```

### 2. Use a local build (for development / debugging)

```bash
# Clone and build the plugin
git clone https://github.com/zenith-protocols/relayer-plugin-zenex.git
cd relayer-plugin-zenex
npm install
npm run build
```

Now reference the local build from your Relayer's `plugins/package.json`:

```jsonc
{
  "dependencies": {
    "@zenith-protocols/relayer-plugin-zenex": "file:../../relayer-plugin-zenex",
  },
}
```

and run `npm install` there.

### Create the plugin wrapper

Inside the Relayer create a directory for the plugin and expose its handler:

`plugins/zenex/index.ts`

```ts
export { handler } from '@zenith-protocols/relayer-plugin-zenex';
```

### Configure the Relayer

The plugin needs a **fund relayer** (pays and simulates; its address is the
simulation source) and one or more **channel relayers** (parallel submission
lanes), each backed by a local signer keystore. Generate keystores with the
relayer repo's official tool:

```bash
git clone https://github.com/openzeppelin/openzeppelin-relayer
cd openzeppelin-relayer
cargo run --example create_key -- --password '<STRONG_PASSWORD>' \
  --output-dir <your-relayer>/config/keys --filename channels-fund.json
# ...repeat for channel-001, channel-002, channel-003
```

More channels = more parallel submissions; add a signer + relayer entry per
channel in the config.

Then add the signers, relayers, and the plugin entry to your relayer's
`config.json`:

```jsonc
{
  "plugins": [
    {
      "id": "zenex",
      "path": "zenex/index.ts",
      "timeout": 30,
      "emit_logs": false,
      "config": {
        "router": "C...ROUTER",
        "feeRecipient": "G...RECIPIENT",
        "fees": {
          "feeRateBps": 30,
          "feeToken": { "contractId": "C...USDC", "decimals": 7 },
        },
        "xlmUsdFeedId": "0x000358cb12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a",
      },
    },
  ],
}
```

Every key the plugin reads is validated for type and value; unrecognized keys
are ignored, matching the channels plugin's config convention (requests, by
contrast, are strictly validated — unknown body keys are rejected). There is
no market map — clients supply `feedId` (a Data Streams feed id, bytes32 hex)
per request. `xlmUsdFeedId` is the XLM/USD stream the relay prices its fee
conversion with; it must come from the same environment catalog as the network
(`STELLAR_NETWORK` selects `api.testnet-dataengine.chain.link` or
`api.dataengine.chain.link`). `feeRecipient` must be
able to hold the fee token (for a SAC-wrapped asset like USDC, a `G...`
recipient needs the trustline) — otherwise every relayed transaction fails at
the fee transfer.

Keep `emit_logs` off outside development: the plugin envelope returns emitted
logs to the caller in `metadata.logs`, which includes raw simulation
diagnostics.

### Configure Environment Variables

These are **not settings invented for this plugin** — with two exceptions, they
are properties of the relayer deployment this plugin runs inside:

| Variable          | Origin                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STELLAR_NETWORK` | Required by the embedded channels code, which reads it from `process.env` on every call. Any channels-capable relayer deployment already sets it. This plugin reads the same variable (deliberately — a duplicated network setting that could disagree with channels would be a silent passphrase mismatch on the funds path). |
| `FUND_RELAYER_ID` | Same: required by the embedded channels code. Also names the relayer whose RPC passthrough carries this plugin's chain reads and whose address is the boot-fetched simulation source.                                                                                                                                          |
| `DS_USER_ID`      | One of the two variables this plugin adds: the Chainlink Data Streams user ID (the portal's "API key" UUID), sent as the `Authorization` header value.                                                                                                                                                                         |
| `DS_HMAC_SECRET`  | The other: the Data Streams HMAC signing secret. A secret, so both live in env rather than `plugins[].config` (that block sits on disk and is readable/patchable through the relayer's plugin API).                                                                                                                            |

The embedded channels code also honors its own optional env vars
(`PLUGIN_ADMIN_SECRET`, `LOCK_TTL_SECONDS`, fee tracking, timeouts, …) — see
the [channels plugin README](https://github.com/OpenZeppelin/relayer-plugin-channels)
for the full list. `PLUGIN_ADMIN_SECRET` is required if you want to seed the
channel roster through the management API (next step).

### Fund the relayer accounts (testnet)

```bash
curl -s http://localhost:8080/api/v1/relayers \
  -H "Authorization: Bearer $API_KEY" | python3 -m json.tool | grep address
# friendbot each address on testnet:
curl -s "https://friendbot.stellar.org?addr=<ADDRESS>"
```

### Seed the channel roster

The embedded channels code keeps its pool state under THIS plugin's KV
namespace, so the roster must be seeded through this plugin's bare route:

```bash
curl -s -X POST http://localhost:8080/api/v1/plugins/zenex/call \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d "{\"params\":{\"management\":{\"adminSecret\":\"$PLUGIN_ADMIN_SECRET\",
       \"action\":\"setChannelAccounts\",
       \"relayerIds\":[\"channel-001\",\"channel-002\",\"channel-003\"]}}}"
```

### Smoke test

From this repo's checkout, against your running relayer:

```bash
npm ci
API_KEY=<your-key> npx tsx scripts/smoke.ts
# env/flags: API_KEY (--api-key), RELAYER_URL (--base-url), PLUGIN_ID (--plugin-id)
```

The script friendbots a throwaway user, prepares an XLM self-transfer through
`multicall_with_fee` using `ZenexClient`, signs the returned auth entry,
submits, polls until the transaction lands, and prints the on-chain result.
`on-chain: SUCCESS` means the full pipeline works.

For a testnet smoke test, set `fees.feeToken.contractId` to the **native XLM
SAC** (`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`): prepare's
placeholder fee makes every simulation run the fee leg, so throwaway friendbot
users must be able to pay in the fee token — with XLM they always can. In
production use the real collateral token (users hold it by definition).

## Development

```bash
npm install        # dependencies
npm run build      # compile to dist/
npm test           # vitest suite
npm run lint:check # eslint
npm run prettier:check
```

## Client

`ZenexClient` wraps the plugin's routes with typed requests, the plugin
response envelope, and a typed error hierarchy (`PluginTransportError`,
`PluginExecutionError`, `PluginUnexpectedError`) — the same shape as the
channels plugin's `ChannelsClient`:

```ts
import { ZenexClient } from '@zenith-protocols/relayer-plugin-zenex';

// Relayer mode: straight at the relayer's plugin API
const client = new ZenexClient({
  baseUrl: 'http://localhost:8080',
  pluginId: 'zenex',
  apiKey: 'your-relayer-api-key',
});

// Direct HTTP mode: through the public edge service in front of the relayer
// (posts {params} to `${baseUrl}/prepare/*`, `/submit`, and `/status`)
const edge = new ZenexClient({ baseUrl: 'https://relay.example.com' });

const prepared = await client.prepareCalls({
  user: 'G...',
  calls: [callXdr],
  expirationLedger,
  maxFeeAmountAtomic: '1000000',
});
// wallet signs prepared.authEntries[..] (SEP-43: payloadHash or entry xdr)
const submitted = await client.submit({ func: prepared.func, auth: signedEntries });
const status = await client.getTransaction({ transactionId: submitted.transactionId! });
```

`prepareFill` / `prepareTryFill` take the same request with a required
`feedId` (a Data Streams feed id, bytes32 hex). In relayer mode `getTransaction` uses the embedded channels surface
on the bare route; in direct mode it posts to the edge service's `/status`.

## Routes

`POST /api/v1/plugins/zenex/call` with `context.route`:

- `/prepare/calls` — unpriced multicall preparation
- `/prepare/fill` — priced fill preparation (`feedId` required)
- `/prepare/try-fill` — priced try-fill preparation (`feedId` required)
- `/submit` — submit signed auth entries; answers channels' response verbatim:
  `{transactionId, status, hash}` with `hash` usually still `null`

Status polling has no plugin route: the returned `transactionId` is looked up
on the relayer's core transactions API
(`GET /api/v1/relayers/{fundRelayerId}/transactions/{transactionId}` — the
same call channels' own `getTransaction` makes internally), which the edge
Worker exposes to clients as its own `/status` endpoint.

Polling is the client's job (channels' own `skipWait` contract): the plugin
holds no connection open and keeps no submission state. Errors follow channels
too — its codes propagate unmapped, and this plugin's simulation failures
answer `SIMULATION_FAILED` with the parsed diagnostic in `details.error`. The
plugin decodes nothing; clients decode `Error(Contract, #N)` with the zenex
SDK.

**The bare `/call` route (empty route tail) exposes the embedded channels
handler's entire native surface** — `{func, auth}` and `{xdr}` raw submission,
`{getTransaction}`, and `{management}` — with the untouched context. Keepers
and platform services submit raw (no fee abstraction) through the SAME channel
pool, locks, and sequence caches as fee-abstracted traffic, which is the
supported way to do raw channel submission alongside this plugin. Channels'
own strict validation and `adminSecret` gate own that surface; its errors
propagate unmapped. Any other route is a 404.

**Edge contract:** raw submission is unpoliced sponsorship (no Router gate, no
fee), so the Cloudflare Worker in front of the relayer must forward only
`/call/prepare/*` and `/call/submit` to the public internet, and serve status
polling itself by calling the core transactions API with its key (the client
supplies only the `transactionId`). The bare `/call` route is the privileged
surface, reachable only with the relayer API key.
Public authentication and CORS are owned by the Worker; this plugin trusts its
caller.

## Deployment constraints

- **Channel accounts must be exclusive to this plugin.** The embedded channels
  handler runs its pool locks and sequence caches in the ZENEX plugin's KV
  namespace (the relayer core namespaces KV by plugin id). A standalone
  channels plugin instance configured over the _same_ channel relayer accounts
  would hold its locks in a different namespace, so both plugins could acquire
  the same channel account concurrently and race on sequence numbers
  (`tx_bad_seq` / duplicate submits). Either give this plugin a disjoint
  channel relayer pool, or do not deploy the standalone channels plugin
  alongside it.
- **Channels' per-fund-relayer overrides pass through.** The embedded channels
  code reads `fundRelayers` from this plugin's config block (`context.config`
  is handed over untouched), so per-fund-relayer overrides — dynamic fees,
  timeouts, transaction params — work here exactly as they do in a standalone
  channels deployment.

## License

This project is licensed under the MIT License — see [LICENSE](./LICENSE).
