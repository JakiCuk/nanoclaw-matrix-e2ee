---
name: add-matrix-e2ee
description: Add Matrix channel with working end-to-end encryption via matrix-bot-sdk — persistent device identity, encrypted attachments, and clickable choices as reactions. Replaces the stock Chat SDK bridge Matrix adapter.
---

# Add Matrix Channel (E2EE, native)

Adds Matrix support through a **native** adapter built on
[matrix-bot-sdk](https://github.com/turt2live/matrix-bot-sdk), rather than the Chat SDK bridge
that NanoClaw's stock `/add-matrix` installs. The adapter is fetched from
[JakiCuk/nanoclaw-matrix-e2ee](https://github.com/JakiCuk/nanoclaw-matrix-e2ee).

Use this instead of `/add-matrix` when you need encrypted rooms to actually work. Three things
are structurally impossible in the bridge stack, because `matrix-js-sdk`'s rust-crypto has no
persistent Node storage backend and `@beeper/chat-adapter-matrix` reads only `content.url`:

- the bot's device identity is regenerated on every start, so peers stop sending it room keys
  and it sees nothing but "Unable to decrypt"
- attachments in encrypted rooms don't work in either direction
- `ask_user_question` renders as buttons Matrix cannot display, so it hangs until it times out

The mechanical steps under **Apply** carry `nc:` directive fences: an agent reads the prose and
applies them, and a parser can apply them deterministically from the same document. Every
directive is idempotent, so the whole skill is safe to re-run.

## Apply

### 1. Fetch the adapter

Downloads the adapter into `src/channels/` (overwrite — the repo is canonical):

```nc:run effect:external
curl -fsSL https://raw.githubusercontent.com/JakiCuk/nanoclaw-matrix-e2ee/main/src/matrix-bot-sdk.ts -o src/channels/matrix-bot-sdk.ts && echo "Fetched src/channels/matrix-bot-sdk.ts"
```

### 2. Approve the crypto package's build script

This one needs a human decision, so read it before continuing.

```nc:operator
This adapter's encryption comes from @matrix-org/matrix-sdk-crypto-nodejs, whose postinstall
script downloads a prebuilt Rust binary from the matrix-org GitHub releases at install time.

pnpm blocks build scripts by default. Without this one there is no encryption at all — the
package is inert. Allowing it means that package runs code on your machine during install.

The script is download-lib.js in the package, and the binary comes from
https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/releases

If you are not comfortable with that, stop here and use the stock /add-matrix instead.
```

### 3. Allow the build script

Adds the package to `onlyBuiltDependencies` in `pnpm-workspace.yaml` (skipped if already listed).
This must happen **before** the install in step 5, or pnpm silently skips the postinstall and
encryption fails at runtime with no obvious cause:

```nc:run effect:external
node -e '
  const fs = require("fs");
  const f = "pnpm-workspace.yaml";
  const pkg = "@matrix-org/matrix-sdk-crypto-nodejs";
  let s = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  if (s.includes(pkg)) { console.log("Already allowed"); process.exit(0); }
  const entry = "  - \"" + pkg + "\"\n";
  s = /^onlyBuiltDependencies:/m.test(s)
    ? s.replace(/^onlyBuiltDependencies:\n/m, "onlyBuiltDependencies:\n" + entry)
    : "onlyBuiltDependencies:\n" + entry + "\n" + s;
  fs.writeFileSync(f, s);
  console.log("Allowed", pkg);
'
```

### 4. Register the adapter

Only one Matrix adapter may be active — both register the `matrix` key. Comment out the stock
import if it is present (idempotent: after the first run the line no longer starts with `import`):

```nc:run effect:external
sed -i.bak "s|^import '\./matrix\.js';|// import './matrix.js';  // disabled — replaced by matrix-bot-sdk.js|" src/channels/index.ts && rm -f src/channels/index.ts.bak && echo "Stock Matrix import disabled (if it was present)"
```

Then append this adapter's self-registration import. This one line is the skill's only reach-in
into core:

```nc:append to:src/channels/index.ts
import './matrix-bot-sdk.js';
```

### 5. Install the dependencies

Exact pins — the supply-chain policy rejects ranges. `@matrix-org/matrix-sdk-crypto-nodejs` is
held at 0.4.0 deliberately: 0.6.1 declares `node >= 24`, while NanoClaw supports Node 22.
If you are on Node 24 or newer you may raise it:

```nc:dep
matrix-bot-sdk@0.8.0
@matrix-org/matrix-sdk-crypto-nodejs@0.4.0
```

### 6. Build

Build proves the adapter typechecks against the `ChannelAdapter` interface, that both packages
installed, and that the channel barrel still evaluates:

```nc:run effect:build
pnpm run build
```

Verify the native crypto binary actually landed — if step 3 was skipped this is where you find
out, rather than at runtime:

```nc:run effect:test
node -e 'const c = require("@matrix-org/matrix-sdk-crypto-nodejs"); if (typeof c.OlmMachine !== "function") { throw new Error("crypto binary missing — was the build script allowed?"); } console.log("Crypto binary OK");'
```

End-to-end delivery against a real homeserver is verified manually once the service runs — see
Next Steps.

## Credentials

The bot needs **its own Matrix account**, separate from yours — Matrix cannot DM your own
account. These steps are human and interactive, so they stay prose.

### Create a bot account

1. Open [app.element.io](https://app.element.io) in a private window (or sign out first)
2. Register a new account for the bot, e.g. `mybot`
3. Note its full user ID, e.g. `@mybot:example.org`

### Find the homeserver API URL

The API host is often **not** the server name in your user ID. Check:

```bash
curl -s https://example.org/.well-known/matrix/client
```

The `m.homeserver.base_url` in the response is what you want (e.g. `https://matrix.example.org`).

### Store the credentials

This adapter uses password auth only. The password is used for the **first login**; the
resulting access token and device id are then cached to `data/matrix-bot-sdk/creds.json` and
reused, which is what keeps the device — and thus decryption — stable.

```nc:prompt base_url normalize:rstrip-slash validate:^https://
Paste the homeserver client-server API base URL, e.g. `https://matrix.example.org`. Check
`.well-known/matrix/client` if unsure — this is often not the same host as your user ID.
```
```nc:prompt username normalize:trim
The bot's login username — the localpart only, e.g. `mybot` (not the full `@mybot:example.org`).
```
```nc:prompt password secret
The bot account's password.
```
```nc:prompt bot_username normalize:trim
A display name for the bot, e.g. `MyBot`. Used to detect mentions in group rooms.
```
```nc:env-set
MATRIX_BASE_URL={{base_url}}
MATRIX_USERNAME={{username}}
MATRIX_PASSWORD={{password}}
MATRIX_BOT_USERNAME={{bot_username}}
MATRIX_INVITE_AUTOJOIN=true
```

Optionally restrict who may invite the bot into rooms — with this set, invites from anyone else
are ignored, which is the simplest way to keep a personal bot personal:

```nc:prompt autojoin_allowlist normalize:trim
Optional — comma-separated Matrix user IDs allowed to invite the bot, e.g.
`@you:example.org`. Leave empty to accept invites from anyone.
```
```nc:env-set
MATRIX_INVITE_AUTOJOIN_ALLOWLIST={{autojoin_allowlist}}
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise restart the service, then run `/manage-channels` to wire this channel to an agent
group. Invite the bot to a room from your own account and send it a message.

## Channel Info

- **type**: `matrix`
- **terminology**: Matrix has "rooms" — a room is either a group chat or a direct message. Rooms have internal IDs (`!abc123:example.org`) and optional aliases (`#general:example.org`).
- **how-to-find-id**: DMs are addressed by the user's handle (`matrix:@user:example.org`), not the room id — the adapter resolves the room via `m.direct`. For group rooms, in Element: room name > Settings > Advanced > "Internal room ID".
- **supports-threads**: no (the channel itself is the conversation unit)
- **typical-use**: Interactive chat in encrypted or unencrypted rooms. Requires a dedicated bot account.
- **default-isolation**: Same agent group for your own rooms. Separate agent group for rooms with other communities or sensitive contexts.

## Limitations

- **Reactions are not encrypted.** Matrix never encrypts `m.reaction`, so the homeserver sees which keycap was tapped on which event. It does not see the question or the option labels. Consider this before using clickable choices for sensitive approvals.
- **No key backup.** The bot cannot read encrypted history from before its device existed. `matrix-bot-sdk` exposes no key-backup or secret-storage API, so a `MATRIX_RECOVERY_KEY` from another client cannot be used here.
- **Maximum 10 options** per question.
- **matrix-bot-sdk is beta** (0.8.0), single-maintainer, and still depends on the deprecated `request` HTTP stack.

## Troubleshooting

**Every inbound message is "Unable to decrypt", or the peer's client shows a new unverified device after each restart.** The crypto store isn't persisting. Check that `data/matrix-bot-sdk/crypto/matrix-sdk-crypto.sqlite3` exists and that `data/matrix-bot-sdk/creds.json` is not being recreated on each start — a new `Matrix: logged in and cached device` line on every boot means the creds file isn't surviving. Confirm the directory is writable by the user the service runs as.

**Encryption silently doesn't work / `OlmMachine is not a function`.** The build script was blocked. Re-run steps 3 and 5, then the verification in step 6. `pnpm install` skips the postinstall unless the package is in `onlyBuiltDependencies`, and it does not warn loudly.

**Login fails with `M_FORBIDDEN`.** `MATRIX_USERNAME` must be the bare localpart (`mybot`), not the full user ID. Also confirm `MATRIX_BASE_URL` is the client-server API URL from `.well-known/matrix/client`, not the server name.

**`M_UNKNOWN_TOKEN` on start.** The cached access token was invalidated — usually because the bot's device was logged out from another client, or another process is running the same bot account and pruning its devices. Delete `data/matrix-bot-sdk/creds.json` to force a fresh login, and make sure only one NanoClaw host is running.

**Two adapters registered / the wrong one is active.** `src/channels/index.ts` must import exactly one Matrix adapter. Re-run step 4, then rebuild.

**The bot never joins your room.** `MATRIX_INVITE_AUTOJOIN_ALLOWLIST` is set and doesn't include your user ID, so your invite is ignored. Check the service log for "ignoring invite from non-allowlisted user".
