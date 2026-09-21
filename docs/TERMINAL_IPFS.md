# Terminal, independent reads and IPFS

The terminal is `apps/terminal/index.html`: one file, no build, external font, library or remote script.
It works on the indexer's origin or as a static IPFS page. HTTP APIs remain external; a CID does not contain
live prices or an RPC node. Both deployments in the embedded release registry are **testnets**.

## Read the heartbeat

- The latest observed Bitcoin height and explorer-order hash link to mempool.space. The timestamp age is
  explicitly the **header timestamp**, not the time our machine received it. A future timestamp is labelled.
- Six descendants are required before a height enters the index. The terminal shows the folded height,
  backlog and next series boundary, with remaining heights measured from the **contract** index.
- `Steps` preserves horizontal plateaus and vertical jumps at the cached confirmed-second timestamps.
  `Candles` and `Line` remain available. Values on this chart are the display index `100e^S`, not token quotes.
- The displayed next-block estimate is the observed average from
  `https://mempool.space/api/v1/difficulty-adjustment` (`timeAvg`, milliseconds), refreshed every five minutes.
  If the request fails or its result is ten minutes old, use the labelled ten-minute protocol target.
  There is no promise of a block in that period and no “overdue” countdown. The estimate is not used in settlement.

## Select an indexer and check the RPC

Open **数据源 · 核验**. Enter up to twelve indexer base URLs, one per line, save, select a source and save again.
Preferences persist in that browser origin. Source switching reloads the page and discards old price buffers,
block caches and verification results. Existing same-origin paper accounts are retained; custom sources have
separate local paper accounts. A different origin/CID may have different storage. This is paper data, not keys.

Public endpoints require HTTPS. Plain HTTP is allowed only on loopback for local development. Browser CORS and
mixed-content rules still apply; do not disable them. The Bitcoin indexer now permits cross-origin public GETs
and OPTIONS, without credentials; it does not expose a signing API. Publish an HTTPS reverse proxy for a public
indexer. An HTTPS gateway normally cannot read an HTTP localhost indexer. Public RPC URLs are saved locally;
there is no support for credentials in these URL fields. Never put secrets in an IPFS page or browser URL.

Choose a deployment and RPC independently. The registry in the HTML fixes the reviewed v3 index, relay, vault,
collateral and notional addresses from the two public deployment manifests. The indexer cannot supply a new
RPC URL or substitute a new signing target. Other releases remain readable as cached indexes but their wallet
writes are disabled until supported by an explicitly reviewed release of the terminal.

The browser checks chain ID, pins every `eth_call` to one EVM block, validates its timestamp (within 120 seconds),
and rechecks its hash after reading. It compares exact signed `S_wad`, folded height/hash, indexer's same-height
S/hash, exact `yangShare_wad`, series fields and token addresses. It also checks vault→index, collateral,
notional and index→relay against the embedded registry. No floating-point rounding is used for integer comparisons.

The indexer snapshot must be recently received (30 seconds), carry a recent server clock (90 seconds), and have
no reported source/RPC error or halt. When available its `observedAt` selects the common EVM block. Without a
comparable indexer snapshot the browser reads the RPC's latest block and says **仅浏览器直读**, never “agreement”.
Read every 30 seconds or click **立即核验**. A result expires after 60 seconds; errors/source changes clear the green
badge immediately. Old on-chain cells disappear when indexer data becomes unavailable, even if the chart is idle.
A green result describes that labelled snapshot, not continuous synchronization or a guarantee of keeper liveness.

Wallet approvals and mint/redeem sends require a fresh matched snapshot with the selected vault's
bindings. This is a UI check only; permissionless contract calls remain available independently. It must not be
confused with a protocol pause or exit mechanism. Chain/account/vault checks still run before sending each step.

**This is a second read path, not a trustless RPC or full Bitcoin validation.** An RPC can lie, two URLs can use
one provider, and the indexer and browser may share a provider by default. Configure a genuinely independent
provider for provider diversity. Run `scripts/wuji-verify.mjs` for independent header reconstruction and
`verify-bytecode.sh` for code reproduction; neither a green badge nor a CID replaces independent review.

## Pin the single file

Install [Kubo](https://docs.ipfs.tech/install/command-line/) and initialize a repository you control:

```bash
ipfs init
# Optional: choose a separate repo with IPFS_PATH. Never commit its config/identity.
IPFS_PATH="$HOME/.ipfs" bash scripts/publish-ipfs.sh
# A non-PATH binary is also supported:
IPFS_BIN=/path/to/ipfs IPFS_PATH=/path/to/ipfs-repo bash scripts/publish-ipfs.sh
```

The script stages **only** `index.html`, excluding tests, dotfiles, contracts, caches and credentials. It uses
CIDv1, SHA-256, raw leaves and fixed 256 KiB chunks, recursively pins the directory, verifies the recursive pin,
then reads `/ipfs/<CID>/index.html` back and compares bytes. Stdout contains only the root directory CID;
operational messages go to stderr. The temporary staging directory is removed on success or failure.
The same input and import options yield the same CID. Any subsequent HTML change requires a new pin/CID.

Kubo 0.43.1 was used for the delivery check. The [Kubo CLI reference](https://docs.ipfs.tech/reference/kubo/cli/)
describes `add`, `pin ls` and `cat`. A local pin protects against that node's garbage collection; it does not make
the file permanently available to the public. Keep a networked node running and replicate the CID with another
node or a pinning service before announcing it. Test an external gateway from an independent connection.

For local inspection, start `ipfs daemon` with your chosen `IPFS_PATH` and open
`http://127.0.0.1:8080/ipfs/<CID>/`. Keep the API bound to loopback. The delivery smoke test used an **offline**
node and loopback gateway, so it does not establish public propagation or permanent hosting.

## `wuji.market` when the domain exists

No domain registration, public pinning service or DNS change is included in this delivery.

1. Secure the domain, choose a gateway that supports your custom hostname and TLS, and replicate the pin.
2. Set the domain's A/AAAA or provider-supported CNAME/ALIAS according to that gateway's instructions.
   An apex domain is not generally a place for an ordinary CNAME; use the DNS provider's supported method.
3. Add TXT at `_dnslink.wuji.market` with the exact value `dnslink=/ipfs/<CID>` (directory CID).
4. Verify the TXT record, HTTPS certificate and `https://wuji.market/` from an independent connection. Confirm
   it serves the intended bytes, then configure an HTTPS/CORS indexer and independent RPC in the terminal.
5. For an update, pin and test the new CID first, change the DNSLink TXT, retain the old pin for rollback,
   and account for DNS/gateway caches. DNS control can repoint the domain; the old CID remains immutable.

See [DNSLink](https://docs.ipfs.tech/concepts/dnslink/) and
[custom-domain hosting](https://docs.ipfs.tech/how-to/websites-on-ipfs/custom-domains/).
Prefer a subdomain gateway (distinct origin per CID) over a shared path gateway for wallet use; a conventional
HTTP gateway remains a trusted content delivery path unless the client independently verifies its blocks.
