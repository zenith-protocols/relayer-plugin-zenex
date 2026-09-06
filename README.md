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

Every key the plugin reads is validated for type and value, and an unrecognized
key is a hard config error rather than something silently ignored: the embedded
channels code reads this same `plugins[].config` block for its own per-fund-relayer
overrides and tolerates what it does not recognize, so a channels-only key
(`fundRelayers`, say) or a plain typo has to fail loudly here instead of sitting
in the file doing nothing. Request bodies are strict the same way — unknown body
keys are rejected. There is no market map — clients supply `feedId` (a V3 Data
Streams feed id: `0x0003…` bytes32 hex) per request. `xlmUsdFeedId` is the
XLM/USD stream the relay prices its fee conversion with; it must come from the
same environment catalog as the host (`STELLAR_NETWORK` selects
`api.testnet-dataengine.chain.link` or `api.dataengine.chain.link`, unless
`DS_API_HOST` overrides it). `feeRecipient` must be able to hold the fee token
(for a SAC-wrapped asset like USDC, a `G...` recipient needs the trustline) —
otherwise every relayed transaction fails at the fee transfer.

Keep `emit_logs` off outside development: the plugin envelope returns emitted
logs to the caller in `metadata.logs`, which includes raw simulation
diagnostics.

### Configure Environment Variables

These are **not settings invented for this plugin** — with the `DS_*` exceptions,
they are properties of the relayer deployment this plugin runs inside:

| Variable          | Origin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STELLAR_NETWORK` | Required by the embedded channels code, which reads it from `process.env` on every call. Any channels-capable relayer deployment already sets it. This plugin reads the same variable (deliberately — a duplicated network setting that could disagree with channels would be a silent passphrase mismatch on the funds path).                                                                                                                                                                                                                                                                                                                                         |
| `FUND_RELAYER_ID` | Same: required by the embedded channels code. Also names the relayer whose RPC passthrough carries this plugin's chain reads and whose address is the boot-fetched simulation source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DS_USER_ID`      | Added by this plugin: the Chainlink Data Streams user ID (the portal's "API key" UUID), sent as the `Authorization` header value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DS_HMAC_SECRET`  | Added by this plugin: the Data Streams HMAC signing secret. Both are secrets, so they live in env rather than `plugins[].config` (that block sits on disk and is readable/patchable through the relayer's plugin API).                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DS_API_HOST`     | Optional, added by this plugin: overrides the Data Streams host `STELLAR_NETWORK` would select. Set it when the Data Streams environment and the Stellar network differ — settling on Stellar testnet against a shadow verifier that accepts mainnet DON reports means fetching those reports from `https://api.dataengine.chain.link` with mainnet credentials. Must be an `https://` URL with no embedded credentials, query, or fragment — with one exception for local mocks: cleartext `http://` is accepted when the host is loopback (`localhost`, `127.0.0.0/8`) or RFC1918-private IPv4 (`10/8`, `172.16/12`, `192.168/16`). Anything else fails config load. |

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
`feedId` (a V3 Data Streams feed id: `0x0003…` bytes32 hex). In relayer mode `getTransaction` uses the embedded channels surface
on the bare route; in direct mode it posts to the edge service's `/status`.

The package also exports `isResourceLimitFailure`, which tells a polling client
whether a failed transaction is worth one more prepare and submit (see Resource
margin).

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
`{getTransaction}`, and `{management}` — with the context untouched except for
the resource margin on its simulations (see Resource margin). Keepers
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

## Resource margin

A Soroban transaction declares the resources it may consume, and the relay
sizes that declaration from a simulation. The simulation reads the ledger one
or more ledgers before execution. Another transaction can extend the same
position row or the market singleton in between, so the write set at execution
is larger than the simulated one and the ledger rejects the transaction with
`txSorobanInvalid` and a "resources exceeds amount specified" diagnostic.

Every simulation this plugin makes, and every simulation the embedded channels
handler makes, runs over a margined relayer API. The margin adds 20 percent to
the simulated instructions, disk read bytes and write bytes, with a floor of
512 bytes on the two byte dimensions. Each dimension is clamped to the
network's per-transaction limit and never falls below the simulated value. The
resource fee rises by the largest of the three growth factors, so a footprint
the clamps hold keeps its own fee. The fee the user pays is priced off the
margined resource fee, so the margin is funded. `RESOURCE_MARGIN` in
`src/plugin/constants.ts` holds both numbers.

A submission that still fails on a resource limit gets one more attempt with a
fresh price report and a fresh simulation (`SUBMIT.MAX_ATTEMPTS`). The failure
must name a resource: the "resources exceeds amount specified" diagnostic, or a
`ResourceLimitExceeded` operation result. A bare `txSorobanInvalid` also carries
an invalid footprint and an insufficient resource fee, which no retry clears, so
it answers on the first attempt like every other failure. The response shape
does not change.

Clients classify a failure they poll for themselves. The package exports
`isResourceLimitFailure(failure)`, which accepts a thrown `PluginExecutionError`,
a plugin error body, or a status reason string, and answers whether one more
prepare and submit is worth it.

## Batch calls pass through

Inner-call targets and arguments pass through without plugin policy
validation — the wrapper itself is still checked: `parseSubmitRequest` pins the
Router target, the `*_with_fee` ABI at exact arity, the fee envelope, and the
structure of every inner call it decodes. What it does not do is judge what
those calls point at or carry.

Soroban auth is their gate: the user's
signature covers the inner calls together with the fee constraints — the call
vector, the fee token, the fee cap, and the fee expiration ledger (the Router
auth projection, args 0/2/3/4). Within those constraints the relay fills the
tail it must compute itself: the actual fee amount (rejected if it exceeds the
signed cap), the fee recipient, the keeper, and the price report. So the user
does not sign the final wrapper byte-for-byte; they sign what the calls do and
the most they can be charged for it.

The relay validates its own transaction shape (the Router `*_with_fee` entry
points at exact arity, the configured fee token, the fee envelope) and nothing
about the inner calls' targets or arguments — the user pays the relay fee for
whatever they submit. Smart-account mutations such as `add_context_rule` are
the user's own business on the user's own account.

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
- **Channels' per-fund-relayer overrides are not configurable here.** The
  embedded channels code reads `context.config`, but this plugin parses that
  block strictly and rejects every key it does not define — `fundRelayers`
  included — so channels-only overrides (dynamic fees, timeouts, transaction
  params) cannot be passed through it. A stray override fails config load
  loudly instead of being silently ignored.

## License

This project is licensed under the MIT License — see [LICENSE](./LICENSE).
