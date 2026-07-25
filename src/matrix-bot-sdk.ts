/**
 * Matrix channel adapter (v2) — NATIVE, built on matrix-bot-sdk.
 *
 * This is the replacement for the Chat SDK bridge version in ./matrix.ts.
 * Only one of the two may be imported from ./index.ts at a time (both register
 * the 'matrix' key). Rollback = switch that one import line back.
 *
 * Why native rather than the bridge: the bridge speaks the Chat SDK's
 * card/button model, which Matrix has no surface for, and it can only expose
 * what @beeper/chat-adapter-matrix exposes — which notably has no E2EE
 * attachment support in either direction (extractAttachments() reads
 * content.url and returns [] for the content.file that encrypted rooms
 * actually send). Every fix in ./matrix.ts had to reach *through* both layers
 * to matrix-js-sdk. matrix-bot-sdk is not a Chat SDK adapter, so the bridge
 * cannot wrap it regardless.
 *
 * What this buys, concretely:
 *   - A crypto store that PERSISTS (RustSdkCryptoStorageProvider, Sqlite).
 *     matrix-js-sdk's rust-crypto only supports IndexedDB or memory on Node,
 *     which forced a brand-new device on every start — remote clients pin
 *     device identity keys, so they stopped sending us Megolm keys and the
 *     bot saw "Unable to decrypt". A stable device ends that entirely.
 *   - Encrypted attachments via crypto.encryptMedia / decryptMedia.
 *   - Arbitrary event types, so reactions/choices are first-class.
 *
 * Supply chain: @matrix-org/matrix-sdk-crypto-nodejs runs a postinstall that
 * downloads a prebuilt Rust napi binary, so it must be listed in
 * onlyBuiltDependencies (pnpm-workspace.yaml) or pnpm will skip it and there
 * will be no E2EE at all. Pin it to 0.4.0 unless you are on Node 24+: 0.6.1
 * declares node >= 24.
 *
 * Auth: MATRIX_USERNAME + MATRIX_PASSWORD for the first login only. The
 * resulting access token AND device id are cached to disk and reused forever
 * after — minting a new device on each start is the very failure mode this
 * adapter exists to fix.
 */
import fs from 'node:fs';
import path from 'node:path';

import { StoreType } from '@matrix-org/matrix-sdk-crypto-nodejs';
import {
  type EncryptedFile,
  LogLevel,
  LogService,
  MatrixAuth,
  MatrixClient,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} from 'matrix-bot-sdk';

import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

/** Mirrors ./matrix.ts so a cutover does not change wiring behaviour. */
const MATRIX_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

const ENV_KEYS = [
  'MATRIX_BASE_URL',
  'MATRIX_USERNAME',
  'MATRIX_PASSWORD',
  'MATRIX_USER_ID',
  'MATRIX_BOT_USERNAME',
  'MATRIX_INVITE_AUTOJOIN',
  'MATRIX_INVITE_AUTOJOIN_ALLOWLIST',
] as const;

const STATE_DIR = path.resolve('data/matrix-bot-sdk');
const CREDS_PATH = path.join(STATE_DIR, 'creds.json');
const BOT_STORE_PATH = path.join(STATE_DIR, 'bot.json');
const CRYPTO_STORE_PATH = path.join(STATE_DIR, 'crypto');

/** Keycap affordances for clickable choices. Index in this array == option index. */
const CHOICE_KEYS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

type Creds = { baseUrl: string; accessToken: string; userId: string; deviceId: string };

type PendingChoice = { questionId: string; options: Array<{ value: string; label: string }> };

type MatrixTimelineEvent = {
  getType(): string;
  getId(): string;
  getSender(): string | null;
  getContent(): Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// platform_id mapping
//
// A DM's platform_id is the *user handle* ("matrix:@user:example.org"), not the
// room id — rooms are ephemeral, handles are not, and the existing
// messaging_groups / users rows already key off the handle, so a cutover needs
// no DB migration. Group rooms key off the room id instead.
// ---------------------------------------------------------------------------

function prefixed(id: string): string {
  return id.startsWith('matrix:') ? id : `matrix:${id}`;
}

function unprefixed(id: string): string {
  return id.startsWith('matrix:') ? id.slice('matrix:'.length) : id;
}

/**
 * Minimal Markdown → HTML. The agent writes Markdown constantly and Matrix
 * renders `formatted_body` HTML, so without this every reply shows literal
 * asterisks. Escapes first, so no user text can inject markup.
 */
function markdownToHtml(md: string): string {
  const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return escaped
    .replace(/```([\s\S]*?)```/g, (_m, code: string) => `<pre><code>${code.trim()}</code></pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n/g, '<br/>');
}

function readCreds(): Creds | null {
  try {
    const raw = fs.readFileSync(CREDS_PATH, 'utf8');
    const creds = JSON.parse(raw) as Creds;
    if (creds.accessToken && creds.userId && creds.deviceId && creds.baseUrl) return creds;
    return null;
  } catch {
    return null;
  }
}

/**
 * First run only: password-login once and cache the token + device id. Every
 * later start reuses them, which is what keeps the device — and therefore the
 * Olm identity remote clients have pinned — stable.
 */
async function loginAndCache(baseUrl: string, username: string, password: string): Promise<Creds> {
  const auth = new MatrixAuth(baseUrl);
  const client = await auth.passwordLogin(username, password, 'nanoclaw');
  const who = await client.getWhoAmI();

  // Both are load-bearing: without a device id there is nothing stable to
  // persist, which is the entire reason this adapter exists.
  if (!client.accessToken || !who.device_id) {
    throw new Error(
      `Matrix: password login returned an unusable session (token=${Boolean(client.accessToken)}, device=${Boolean(who.device_id)})`,
    );
  }

  const creds: Creds = {
    baseUrl,
    accessToken: client.accessToken,
    userId: who.user_id,
    deviceId: who.device_id,
  };

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  log.info('Matrix: logged in and cached device', { userId: creds.userId, deviceId: creds.deviceId });
  return creds;
}

class MatrixBotSdkAdapter implements ChannelAdapter {
  readonly name = 'matrix';
  readonly channelType = 'matrix';
  readonly supportsThreads = false;
  readonly defaults = MATRIX_DEFAULTS;

  private client: MatrixClient | null = null;
  private creds: Creds | null = null;
  private connected = false;
  private setupConfig: ChannelSetup | null = null;

  /** Question event id → the choice awaiting an answer. */
  private readonly pendingChoices = new Map<string, PendingChoice>();
  /** DM room id → peer user handle, so inbound maps back to a stable platform_id. */
  private readonly roomToUser = new Map<string, string>();

  constructor(private readonly env: Record<string, string>) {}

  isConnected(): boolean {
    return this.connected;
  }

  async setup(config: ChannelSetup): Promise<void> {
    this.setupConfig = config;
    LogService.setLevel(LogLevel.WARN);

    const baseUrl = this.env.MATRIX_BASE_URL;
    this.creds = readCreds() ?? (await loginAndCache(baseUrl, this.env.MATRIX_USERNAME, this.env.MATRIX_PASSWORD));

    fs.mkdirSync(STATE_DIR, { recursive: true });
    const client = new MatrixClient(
      this.creds.baseUrl,
      this.creds.accessToken,
      new SimpleFsStorageProvider(BOT_STORE_PATH),
      // The whole point: crypto state that survives a restart.
      new RustSdkCryptoStorageProvider(CRYPTO_STORE_PATH, StoreType.Sqlite),
    );
    this.client = client;

    if ((this.env.MATRIX_INVITE_AUTOJOIN ?? 'true') === 'true') {
      this.wireAutojoin(client);
    }
    client.on('room.message', (roomId: string, ev: unknown) => {
      void this.onRoomMessage(roomId, ev as Record<string, unknown>);
    });
    client.on('room.event', (roomId: string, ev: unknown) => {
      this.onRoomEvent(roomId, ev as MatrixTimelineEvent & Record<string, unknown>);
    });
    client.on('room.failed_decryption', (roomId: string, ev: Record<string, unknown>, err: unknown) => {
      log.warn('Matrix: failed to decrypt inbound event', { roomId, eventId: ev?.event_id, err });
    });

    await client.start();
    this.connected = true;
    log.info('Matrix (bot-sdk) connected', {
      userId: this.creds.userId,
      deviceId: client.crypto?.clientDeviceId,
      ed25519: client.crypto?.clientDeviceEd25519,
    });

    await this.primeDmCache();
  }

  async teardown(): Promise<void> {
    this.connected = false;
    try {
      this.client?.stop();
    } catch (err) {
      log.warn('Matrix: teardown failed', { err });
    }
    this.client = null;
  }

  /**
   * Autojoin, optionally restricted to an allowlist of inviters so the bot
   * only ever converses with its operator.
   */
  private wireAutojoin(client: MatrixClient): void {
    const allowlist = (this.env.MATRIX_INVITE_AUTOJOIN_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    client.on('room.invite', (roomId: string, ev: Record<string, unknown>) => {
      const inviter = String(ev?.sender ?? '');
      if (allowlist.length > 0 && !allowlist.includes(inviter)) {
        log.warn('Matrix: ignoring invite from non-allowlisted user', { roomId, inviter });
        return;
      }
      client.joinRoom(roomId).catch((err) => log.warn('Matrix: autojoin failed', { roomId, err }));
    });
  }

  /** Warm roomId → handle from m.direct before the first message is dispatched. */
  private async primeDmCache(): Promise<void> {
    try {
      const direct = (await this.client?.getAccountData('m.direct')) as Record<string, string[]> | undefined;
      if (!direct) return;
      for (const [userId, roomIds] of Object.entries(direct)) {
        if (!Array.isArray(roomIds)) continue;
        for (const roomId of roomIds) this.roomToUser.set(roomId, userId);
      }
    } catch (err) {
      log.warn('Matrix: failed to prime DM cache', { err });
    }
  }

  /** Resolve a host platform_id to a room, creating the DM only if needed. */
  private async resolveRoom(platformId: string): Promise<string> {
    const target = unprefixed(platformId);
    if (target.startsWith('!')) return target;

    for (const [roomId, userId] of this.roomToUser) {
      if (userId === target) return roomId;
    }
    // getOrCreateDm consults m.direct (server account data), not local room
    // state — which is what made the previous adapter spawn duplicate rooms
    // right after a restart before its room snapshot had rehydrated.
    const roomId = await this.client!.dms.getOrCreateDm(target);
    this.roomToUser.set(roomId, target);
    return roomId;
  }

  private peerForRoom(roomId: string): string | null {
    return this.roomToUser.get(roomId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private async onRoomMessage(roomId: string, ev: Record<string, unknown>): Promise<void> {
    try {
      const sender = String(ev.sender ?? '');
      if (!sender || sender === this.creds?.userId) return;

      const content = (ev.content ?? {}) as Record<string, unknown>;
      const isDm = this.client!.dms.isDm(roomId);
      if (isDm) this.roomToUser.set(roomId, sender);

      const platformId = isDm ? prefixed(sender) : prefixed(roomId);
      const attachments = await this.extractAttachments(content);
      const text = String(content.body ?? '');

      await this.setupConfig?.onInbound(platformId, null, {
        id: String(ev.event_id ?? ''),
        kind: 'chat',
        timestamp: new Date(typeof ev.origin_server_ts === 'number' ? ev.origin_server_ts : Date.now()).toISOString(),
        isGroup: !isDm,
        // DMs are always "for us". In a group room the platform has no mention
        // signal we can trust, so fall back to our own id/display name.
        isMention: isDm || this.mentionsBot(text),
        content: {
          text,
          sender,
          senderId: prefixed(sender),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      });
    } catch (err) {
      log.error('Matrix: failed to handle inbound message', { roomId, err });
    }
  }

  private mentionsBot(text: string): boolean {
    const id = this.creds?.userId ?? '';
    const localpart = id.startsWith('@') ? id.slice(1).split(':')[0] : id;
    const displayName = this.env.MATRIX_BOT_USERNAME ?? '';
    const haystack = text.toLowerCase();
    return (
      (id.length > 0 && haystack.includes(id.toLowerCase())) ||
      (localpart.length > 0 && haystack.includes(localpart.toLowerCase())) ||
      (displayName.length > 0 && haystack.includes(displayName.toLowerCase()))
    );
  }

  /**
   * Turn a media message into the host's attachment shape (base64 `data`);
   * session-manager writes it into the session inbox and swaps in `localPath`.
   *
   * The encrypted case is the one the bridge adapter never handled: in an
   * encrypted room there is no content.url, only content.file (an
   * EncryptedFile), and the bytes behind it are AES ciphertext.
   */
  private async extractAttachments(content: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const msgtype = String(content.msgtype ?? '');
    const isMedia = ['m.image', 'm.video', 'm.audio', 'm.file'].includes(msgtype);
    if (!isMedia) return [];

    const info = (content.info ?? {}) as Record<string, unknown>;
    const name = String(content.body ?? 'attachment');
    const type = msgtype.replace(/^m\./, '');

    try {
      let data: Buffer;
      if (content.file) {
        data = await this.client!.crypto.decryptMedia(content.file as unknown as EncryptedFile);
      } else if (typeof content.url === 'string') {
        const res = await this.client!.downloadContent(content.url);
        data = res.data;
      } else {
        return [];
      }

      return [
        {
          name,
          type: type === 'file' ? 'file' : type,
          mimeType: typeof info.mimetype === 'string' ? info.mimetype : undefined,
          size: typeof info.size === 'number' ? info.size : data.length,
          data: data.toString('base64'),
        },
      ];
    } catch (err) {
      log.warn('Matrix: failed to fetch/decrypt attachment', { name, msgtype, err });
      return [];
    }
  }

  /** Reactions are how a clickable choice gets answered. */
  private onRoomEvent(roomId: string, ev: MatrixTimelineEvent & Record<string, unknown>): void {
    try {
      if (String(ev.type ?? '') !== 'm.reaction') return;
      const sender = String(ev.sender ?? '');
      if (!sender || sender === this.creds?.userId) return; // our own affordances

      const content = (ev.content ?? {}) as Record<string, unknown>;
      const rel = content['m.relates_to'] as { rel_type?: string; event_id?: string; key?: string } | undefined;
      if (rel?.rel_type !== 'm.annotation' || typeof rel.event_id !== 'string') return;

      const choice = this.pendingChoices.get(rel.event_id);
      if (!choice) return;

      const idx = CHOICE_KEYS.indexOf(String(rel.key));
      if (idx < 0 || idx >= choice.options.length) return;

      this.pendingChoices.delete(rel.event_id); // first answer wins
      log.info('Matrix: choice answered by reaction', {
        questionId: choice.questionId,
        selected: choice.options[idx].value,
        sender,
      });
      this.setupConfig?.onAction(choice.questionId, choice.options[idx].value, prefixed(sender));
    } catch (err) {
      log.warn('Matrix: failed to handle reaction', { roomId, err });
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const roomId = await this.resolveRoom(threadId ?? platformId);
    const content = (message.content ?? {}) as Record<string, unknown>;

    if (content.type === 'ask_question' && typeof content.questionId === 'string') {
      return this.deliverChoice(roomId, content);
    }
    if (content.operation === 'edit' && typeof content.messageId === 'string') {
      return this.editMessage(roomId, content.messageId, String(content.text ?? content.markdown ?? ''));
    }
    if (content.operation === 'reaction' && typeof content.messageId === 'string') {
      await this.client!.unstableApis.addReactionToEvent(roomId, content.messageId, String(content.emoji ?? '👍'));
      return undefined;
    }

    const text = String(content.markdown ?? content.text ?? '');
    let lastId: string | undefined;

    if (text.length > 0) {
      lastId = await this.sendText(roomId, text);
    }
    for (const file of message.files ?? []) {
      lastId = await this.sendFile(roomId, file.filename, file.data);
    }
    return lastId;
  }

  private async sendText(roomId: string, text: string): Promise<string> {
    return this.client!.sendMessage(roomId, {
      msgtype: 'm.text',
      body: text,
      format: 'org.matrix.custom.html',
      formatted_body: markdownToHtml(text),
    });
  }

  /**
   * Upload a file, encrypting it first when the room is encrypted — the bridge
   * adapter uploaded plaintext and set a cleartext `url`, leaving media
   * unprotected inside an otherwise E2EE room.
   */
  private async sendFile(roomId: string, filename: string, data: Buffer): Promise<string> {
    const client = this.client!;
    const encrypted = await client.crypto.isRoomEncrypted(roomId);
    const msgtype = guessMsgType(filename);

    if (!encrypted) {
      const url = await client.uploadContent(data, undefined, filename);
      return client.sendMessage(roomId, { msgtype, body: filename, url });
    }

    const { buffer, file } = await client.crypto.encryptMedia(data);
    const url = await client.uploadContent(buffer, 'application/octet-stream', filename);
    return client.sendMessage(roomId, {
      msgtype,
      body: filename,
      file: { ...file, url },
    });
  }

  private async editMessage(roomId: string, eventId: string, text: string): Promise<string> {
    const html = markdownToHtml(text);
    return this.client!.sendMessage(roomId, {
      msgtype: 'm.text',
      body: `* ${text}`,
      format: 'org.matrix.custom.html',
      formatted_body: `* ${html}`,
      'm.new_content': {
        msgtype: 'm.text',
        body: text,
        format: 'org.matrix.custom.html',
        formatted_body: html,
      },
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    });
  }

  /**
   * ask_user_question as a numbered message plus one keycap reaction per
   * option. Polls (m.poll.start) would be the semantic fit, but client support
   * is uneven — Cinny does not implement polls at all — whereas reactions
   * render in every Matrix client.
   *
   * Caveat: m.reaction is never encrypted, even in an encrypted room, so the
   * homeserver learns which keycap was tapped on which event. It does not
   * learn the question or the option labels; those stay in the encrypted body.
   */
  private async deliverChoice(roomId: string, content: Record<string, unknown>): Promise<string | undefined> {
    const questionId = String(content.questionId);
    const raw = (content.options ?? []) as Array<Record<string, unknown>>;
    const options = raw.slice(0, CHOICE_KEYS.length).map((opt, idx) => ({
      value: String(opt.value ?? idx),
      label: String(opt.label ?? opt.value ?? idx),
    }));
    if (options.length === 0) return undefined;

    const header = [content.title, content.question]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join('\n\n');
    const list = options.map((opt, idx) => `${CHOICE_KEYS[idx]} ${opt.label}`).join('\n');
    const eventId = await this.sendText(roomId, header ? `${header}\n\n${list}` : list);

    this.pendingChoices.set(eventId, { questionId, options });

    // Sequential: the server orders annotations by receipt, so parallel adds
    // would scramble the numbering clients display.
    for (let idx = 0; idx < options.length; idx++) {
      try {
        await this.client!.unstableApis.addReactionToEvent(roomId, eventId, CHOICE_KEYS[idx]);
      } catch (err) {
        log.warn('Matrix: failed to add choice reaction', { questionId, key: CHOICE_KEYS[idx], err });
      }
    }

    log.info('Matrix: choice question delivered', { questionId, options: options.length, eventId });
    return eventId;
  }

  async setTyping(platformId: string, threadId: string | null): Promise<void> {
    try {
      const roomId = await this.resolveRoom(threadId ?? platformId);
      await this.client?.setTyping(roomId, true, 20_000);
    } catch (err) {
      log.warn('Matrix: setTyping failed', { platformId, err });
    }
  }
}

function guessMsgType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) return 'm.image';
  if (['.mp4', '.webm', '.mov', '.mkv'].includes(ext)) return 'm.video';
  if (['.mp3', '.ogg', '.wav', '.flac', '.m4a'].includes(ext)) return 'm.audio';
  return 'm.file';
}

registerChannelAdapter('matrix', {
  factory: () => {
    const env = readEnvFile([...ENV_KEYS]);
    if (!env.MATRIX_BASE_URL) return null;
    // Password auth is required for the first login; afterwards the cached
    // token carries the session, but we keep requiring the env so a lost
    // creds file can always re-bootstrap without manual intervention.
    if (!env.MATRIX_USERNAME || !env.MATRIX_PASSWORD) return null;
    return new MatrixBotSdkAdapter(env as Record<string, string>);
  },
  defaults: MATRIX_DEFAULTS,
});
