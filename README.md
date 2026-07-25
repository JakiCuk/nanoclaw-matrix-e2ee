# nanoclaw-matrix-e2ee

A native Matrix channel adapter for [NanoClaw](https://github.com/nanocoai/nanoclaw) v2, built directly on
[matrix-bot-sdk](https://github.com/turt2live/matrix-bot-sdk) instead of the Chat SDK bridge.

It exists because three things are structurally impossible in the bridge-based Matrix channel that NanoClaw
ships with — not bugs to be fixed there, but consequences of the libraries underneath it.

## Why

NanoClaw's stock Matrix channel is a four-layer stack: NanoClaw's `ChannelAdapter` → Chat SDK bridge →
`@beeper/chat-adapter-matrix` → `matrix-js-sdk`. That works well for platforms shaped like Slack or Discord.
On Matrix it runs into three walls:

**1. The bot's device identity cannot persist.** `matrix-js-sdk`'s rust-crypto layer supports only IndexedDB
(a browser API) or in-memory storage — there is no persistent Node.js backend
([#2144](https://github.com/matrix-org/matrix-js-sdk/issues/2144),
[#4769](https://github.com/matrix-org/matrix-js-sdk/issues/4769)). In memory means the Olm identity keys are
regenerated on every start. Matrix treats a device's identity keys as immutable, so remote clients pin the
originals, reject the rotation, and stop sending Megolm room keys. The bot then sees nothing but
*"Unable to decrypt: The sender's device has not sent us the keys for this message."*

This adapter uses `RustSdkCryptoStorageProvider` backed by SQLite. The device id **and** its ed25519 key
survive restarts, so peers keep talking to it.

**2. Encrypted attachments do not work in either direction.** In an encrypted room, Matrix puts media behind
`content.file` (an `EncryptedFile` with an AES key, IV and hashes), not `content.url`. The bridge adapter's
attachment extraction reads only `content.url`, so it returns nothing and the agent sees just a filename as
text. Outbound, it uploads plaintext bytes and sets a cleartext `url`, leaving media unprotected inside an
otherwise end-to-end encrypted room.

This adapter uses `crypto.encryptMedia` / `crypto.decryptMedia` in both directions.

**3. There is no clickable affordance.** `ask_user_question` renders as a Chat SDK Card with Buttons, which
Matrix has no surface for. It degrades to plain text with nothing to click, so the answer never arrives — and
because the call blocks, it hangs for its full timeout while the user sees an apparently dead bot.

This adapter posts the question as a numbered list and annotates it with one keycap reaction per option.
Tapping one is the click.

## Compatibility

| | Stock (bridge) | This adapter |
|---|---|---|
| Device identity across restart | new device each start | **stable** |
| Inbound encrypted attachments | not surfaced | **decrypted** |
| Outbound attachments in E2EE rooms | uploaded unencrypted | **encrypted** |
| Clickable choices | none | **reactions** |
| Layers between NanoClaw and the homeserver | 4 | 2 |

Clickable choices use reactions rather than Matrix polls (`m.poll.start`) deliberately: poll support across
clients is uneven — Cinny implements none at all — whereas reactions render in every Matrix client, including
FluffyChat, Cinny, Element and Element X.

## Requirements

- NanoClaw v2
- Node.js 22 or newer
- A Matrix account for the bot, and its homeserver's client-server API URL
- pnpm (NanoClaw's package manager)

## Install

**1. Copy the adapter into your NanoClaw checkout:**

```bash
cp src/matrix-bot-sdk.ts /path/to/nanoclaw/src/channels/matrix-bot-sdk.ts
```

**2. Register it** in `src/channels/index.ts`. Exactly one Matrix adapter may be active — both register the
`matrix` key — so comment out the stock one if present:

```ts
import './cli.js';
// import './matrix.js';        // stock Chat SDK bridge adapter
import './matrix-bot-sdk.js';
```

**3. Add the dependencies** to `package.json`:

```json
"matrix-bot-sdk": "0.8.0",
"@matrix-org/matrix-sdk-crypto-nodejs": "0.4.0"
```

`@matrix-org/matrix-sdk-crypto-nodejs` is pinned to 0.4.0 on purpose — 0.6.1 declares `node >= 24`.

**4. Allow its build script.** The crypto package's `postinstall` downloads a prebuilt Rust napi binary from
the [matrix-rust-sdk-crypto-nodejs](https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs) releases.
pnpm blocks build scripts by default, and without this one there is no E2EE at all. Add to
`pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - '@matrix-org/matrix-sdk-crypto-nodejs'
  # ... your existing entries
```

This lets that package execute code at install time. That is a deliberate trust decision — read the
[postinstall script](https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs) before you accept it.

**5. Install, build and restart:**

```bash
pnpm install
pnpm run build
systemctl --user restart nanoclaw-<your-slug>   # Linux
launchctl kickstart -k gui/$(id -u)/com.nanoclaw # macOS
```

## Configuration

In NanoClaw's `.env`:

```bash
MATRIX_BASE_URL=https://matrix.example.org   # client-server API, NOT the server name
MATRIX_USERNAME=mybot                        # localpart only
MATRIX_PASSWORD=...
MATRIX_BOT_USERNAME=MyBot                    # display name, used for mention detection in group rooms
MATRIX_INVITE_AUTOJOIN=true
MATRIX_INVITE_AUTOJOIN_ALLOWLIST=@you:example.org   # optional, restricts who may invite the bot
```

If your homeserver is served on a different host than its server name, use `.well-known` to find the real
API base URL:

```bash
curl -s https://example.org/.well-known/matrix/client
```

The password is used for the **first login only**. The resulting access token and device id are cached to
`data/matrix-bot-sdk/creds.json` (mode `600`) and reused from then on — minting a new device on every start
is the exact failure this adapter exists to avoid. Delete that file to force a fresh login.

## How it works

- **State** lives in `data/matrix-bot-sdk/`: `creds.json` (token + device id), `bot.json` (sync state), and
  `crypto/matrix-sdk-crypto.sqlite3` (the Olm/Megolm store). Keep it — losing it means a new device.
- **`platform_id`** for a DM is the user handle (`matrix:@user:example.org`), not the room id. Rooms are
  ephemeral, handles are not, and this keeps `messaging_groups` rows stable across room changes. Group rooms
  key off the room id instead.
- **DM rooms** are resolved through `m.direct` server account data, so a restart reuses the existing room
  rather than creating a duplicate.
- **Markdown** is converted to Matrix's `formatted_body` HTML (bold, italic, inline code, fenced code,
  links, line breaks).

## Limitations

Worth knowing before you deploy this:

- **Reactions are not encrypted.** Matrix never encrypts `m.reaction`, even in an encrypted room, because the
  server aggregates annotations. Your homeserver therefore learns *which keycap was tapped on which event*.
  It does not learn the question or the option labels — those stay inside the encrypted message body. If that
  matters for your threat model, don't use clickable choices for sensitive approvals.
- **No key backup.** The bot cannot read encrypted history from before its device existed. New conversation
  is unaffected. Migrating from another adapter means the bot starts with no history.
- **Maximum 10 options** per question (one keycap each).
- **Markdown support is a subset.** Tables, blockquotes and nested lists pass through as literal text.
- **matrix-bot-sdk is beta** (0.8.0) and has a single maintainer, and it still depends on the deprecated
  `request` HTTP stack. This is a real tradeoff against `matrix-js-sdk`, which is stable and actively
  developed but cannot persist crypto state on Node.

## Rollback

Switch the import in `src/channels/index.ts` back to `./matrix.js`, rebuild, restart. Nothing else changes —
this adapter uses the same `platform_id` scheme as the stock one, so no database migration is involved in
either direction.

## License

MIT — see [LICENSE](LICENSE).

This adapter is written against NanoClaw's `ChannelAdapter` interface and derives its channel defaults and
overall structure from NanoClaw, which is MIT licensed, © 2026 Gavriel. That attribution is preserved in the
LICENSE file.

`matrix-bot-sdk` (MIT) and `@matrix-org/matrix-sdk-crypto-nodejs` (Apache-2.0) are consumed as npm
dependencies; their source is not redistributed here. Both licenses are compatible with MIT.
