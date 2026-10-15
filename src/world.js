/**
 * 语音转文本 World。
 *
 * 三件事：把一段本地音频（或 log:/mem: 句柄）交给可配置的 ASR 接口转写成文字、
 * 把文字与来源记进转写记录、把回执交给 Core。
 *
 * 这里**不采集**任何声音：没有麦克风、没有实时流、没有语音切分——它是 agent 的
 * 一个批量工具（文件进、文字出）。只依赖框架契约与 Node 内置模块，服务端不需要编译。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

import {
  MIME_BY_EXT,
  SttApiError,
  formatOf,
  sniffAudio,
  transcribeByDashScope,
  transcribeByOpenAi,
} from './api.js';
import { DEFAULTS, ID, configGroup, text } from './config.js';
import { Transcripts } from './transcripts.js';
import { formatKb, formatSeconds, wavInfo } from './wav.js';

const msg = (err) => (err instanceof Error ? err.message : String(err));
const asText = (value) => (typeof value === 'string' ? value.trim() : '');

export class SttWorld {
  #host = null;
  #streams = new Set();
  #transcripts = null;
  #busy = 0;
  #lastError = '';
  #lastItemAt = '';

  constructor(opts = {}) {
    this.id = ID;
    this.cfg = opts.cfg ?? { ...DEFAULTS };
    this.dataDir = opts.dataDir ?? process.cwd();
    this.botDir = opts.botDir ?? process.cwd();
    this.secret = typeof opts.secret === 'function' ? opts.secret : () => '';
    this.storeSecret = typeof opts.storeSecret === 'function' ? opts.storeSecret : () => {};
    this.language = 'zh';
  }

  // -------------------------------------------------------------------------
  // 配置：config.json 的段被控制台热改，每次用时现读
  // -------------------------------------------------------------------------

  #raw(key) {
    const value = this.cfg?.[key];
    return value === undefined || value === null ? DEFAULTS[key] : value;
  }

  #str(key) {
    const value = this.#raw(key);
    const s = typeof value === 'string' ? value.trim() : '';
    return s || String(DEFAULTS[key] ?? '');
  }

  #num(key, min, max) {
    const n = Number(this.#raw(key));
    if (!Number.isFinite(n)) return Number(DEFAULTS[key]) || min;
    return Math.min(Math.max(n, min), max);
  }

  #bool(key) {
    const value = this.#raw(key);
    return typeof value === 'boolean' ? value : Boolean(DEFAULTS[key]);
  }

  #text() {
    return text(this.language);
  }

  /** `worlds.stt.languageHints`：逗号/空格分隔；留空 = 自动识别。 */
  #languageHints() {
    return String(this.#raw('languageHints') ?? '')
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** `worlds.stt.protocol`：dashscope = 百炼同步转写；openai = /v1/audio/transcriptions。 */
  #protocol() {
    return this.#str('protocol') === 'openai' ? 'openai' : 'dashscope';
  }

  /** 记录根目录：配置了就用配置的（相对路径按 bot 目录解析），否则 <dataDir>/stt。 */
  dir() {
    const raw = String(this.#raw('saveDir') ?? '').trim();
    if (!raw) return join(this.dataDir, 'stt');
    return isAbsolute(raw) ? raw : resolve(this.botDir, raw);
  }

  /**
   * 密钥只在内存里过一手，不写 config.json。
   *
   * 先问部署 .env（`ctx.secret`），再退到同级 `providers/<端点>/.env`：
   * 机器上往往已经为别的模型建过端点，密钥名直接填那个就行，不必抄第二份。
   */
  #keyLookup() {
    const name = this.#str('apiKeySecret');
    if (!name) return { name, value: '', from: '', provider: '' };
    let own = '';
    try {
      own = String(this.secret(name) ?? '').trim();
    } catch {
      own = '';
    }
    if (own) return { name, value: own, from: 'bot', provider: '' };
    const found = this.#keyFromProviders(name);
    return {
      name,
      value: found.value,
      from: found.value ? 'provider' : '',
      provider: found.provider,
    };
  }

  /** 扫 `<botDir>/../providers/<端点>/.env`，找同名变量。 */
  #keyFromProviders(name) {
    const root = resolve(this.botDir, '..', 'providers');
    const pattern = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(\\S+)`, 'm');
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const hit = pattern.exec(readFileSync(join(root, entry.name, '.env'), 'utf8'));
        if (hit) return { value: hit[1], provider: entry.name };
      }
    } catch {
      // 没有 providers 目录、或某个端点没有 .env：当作没找到。
    }
    return { value: '', provider: '' };
  }

  apiKey() {
    return this.#keyLookup().value;
  }

  #transcriptsFor() {
    const dir = this.dir();
    const keep = this.#num('keep', 0, 5000);
    if (!this.#transcripts || this.#transcripts.dir !== dir) this.#transcripts = new Transcripts({ dir, keep });
    else this.#transcripts.keep = keep;
    return this.#transcripts;
  }

  #envState() {
    const t = this.#text();
    const protocol = this.#protocol();
    const baseUrl = this.#str('baseUrl');
    const model = this.#str('model');
    const key = this.#keyLookup();
    const name = key.name;
    const keySet = Boolean(key.value);
    const extra = { keyFrom: key.from, keyProvider: key.provider, model, protocol };
    if (!baseUrl) return { ok: false, baseUrl, model, name, keySet, detail: t.readyNoBase, ...extra };
    // openai 兼容的本地服务通常不需要 key；dashscope 必需要有。
    if (protocol === 'dashscope' && !keySet) {
      return { ok: false, baseUrl, model, name, keySet, detail: t.readyNoKey, ...extra };
    }
    if (!model) return { ok: false, baseUrl, model, name, keySet, detail: t.readyNoModel, ...extra };
    return { ok: true, baseUrl, model, name, keySet, detail: t.readyOk(model), ...extra };
  }

  // -------------------------------------------------------------------------
  // 提示词
  // -------------------------------------------------------------------------

  /** 不往系统前缀里加任何东西：工具自身的描述就够了。 */
  envPromptVars() {
    return null;
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  tools() {
    return [
      {
        name: 'stt_transcribe',
        tags: ['read'],
        interruptible: true,
        description: 'Transcribe an audio file to text (batch, not realtime). The audio comes from a local file path or a log:/mem: handle; the text is saved to the transcript list.',
        parameters: {
          type: 'object',
          properties: {
            audio: { type: 'string', description: 'Audio file path (absolute, or relative to the bot workspace) or a log:/mem: handle.' },
            note: { type: 'string', description: 'Short label for the transcript list.' },
            language: { type: 'string', description: 'Language code such as zh / en; overrides the configured hints.' },
            context: { type: 'string', description: 'Exact words (names, terms) likely spoken in the audio, in their original form; the engine matches against this text, so descriptions alone help little. Overrides the configured hint. (dashscope qwen-audio-3.x and openai only.)' },
          },
          required: ['audio'],
        },
        handler: async (args, ctx) => this.#transcribe(args ?? {}, ctx),
      },
    ];
  }

  /** 音频上限（字节）：raw 文件大小；base64 后约 ×1.4。 */
  #maxBytes() {
    return Math.round(this.#num('maxMb', 1, 9) * 1024 * 1024);
  }

  /**
   * 把工具参数里的一句引用解成音频：
   * `log:`/`mem:` 句柄问宿主；否则当路径（绝对 / 先 workspace 再 bot 目录）。
   */
  #resolveAudio(ref) {
    const raw = asText(ref).replace(/^["']|["']$/g, '');
    if (!raw) throw new Error('audio 是空的：给一个音频文件路径，或 log:/mem: 句柄。');
    const maxBytes = this.#maxBytes();
    const maxMb = this.#num('maxMb', 1, 9);

    if (/^(log|mem):/i.test(raw)) {
      let blob = null;
      try {
        blob = this.#host?.blob?.(raw) ?? null;
      } catch {
        blob = null;
      }
      if (!blob) {
        throw new Error(`句柄 ${raw} 解析不出来：log: 句柄来自对话里的附件，mem: 句柄来自工作区；也可以直接给文件路径。`);
      }
      const bytes = Buffer.isBuffer(blob.bytes) ? blob.bytes : Buffer.from(blob.bytes ?? []);
      if (!bytes.length) throw new Error(`句柄 ${raw} 里没有内容`);
      if (bytes.length > maxBytes) {
        throw new Error(`音频 ${formatKb(bytes.length)} 超过上限 ${maxMb} MB（worlds.stt.maxMb）：先裁短或压缩再转。`);
      }
      return this.#describeAudio({ bytes, mimeHint: blob.mime, name: raw, ref: raw, kind: 'handle' });
    }

    const candidates = isAbsolute(raw) ? [raw] : [resolve(this.botDir, 'workspace', raw), resolve(this.botDir, raw)];
    let path = '';
    let size = 0;
    for (const cand of candidates) {
      try {
        if (existsSync(cand) && statSync(cand).isFile()) {
          path = cand;
          size = statSync(cand).size;
          break;
        }
      } catch {
        /* 某个候选读不了就试下一个 */
      }
    }
    if (!path) {
      throw new Error(`找不到音频文件：${raw}（相对路径先按 bot 目录的 workspace/、再按 bot 目录找）`);
    }
    if (size > maxBytes) {
      throw new Error(`音频 ${formatKb(size)} 超过上限 ${maxMb} MB（worlds.stt.maxMb）：先裁短或压缩再转。`);
    }
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch (err) {
      throw new Error(`读不了音频文件：${msg(err)}`);
    }
    return this.#describeAudio({ bytes, mimeHint: '', name: path, ref: path, kind: 'file' });
  }

  /** 认格式：嗅探字节优先，其次扩展名，最后宿主给的 mime。 */
  #describeAudio({ bytes, mimeHint, name, ref, kind }) {
    const ext = extname(name).replace(/^\./, '').toLowerCase();
    const sniffed = sniffAudio(bytes);
    const byExt = ext ? (MIME_BY_EXT[ext] ?? null) : null;
    const hint = String(mimeHint ?? '').trim().toLowerCase();
    const mime = sniffed ?? byExt ?? (hint && hint !== 'application/octet-stream' ? hint : '');
    const info = wavInfo(bytes);
    const fileName = kind === 'handle'
      ? (name.split(/[/\\]/).pop() ?? '').split(':').pop() || 'audio'
      : basename(name);
    return {
      bytes,
      mime,
      format: formatOf(name, mime),
      seconds: info?.seconds ?? null,
      sampleRate: info?.sampleRate ?? null,
      fileName,
      ref,
      kind,
    };
  }

  async #transcribe(args, ctx) {
    const raw = asText(args.audio);
    if (!raw) return { text: '[stt_transcribe 没执行] audio 是空的。给一个音频文件路径或 log:/mem: 句柄；不想转写就别调用。', failed: true };
    let audio;
    try {
      audio = this.#resolveAudio(raw);
    } catch (err) {
      return { text: `[stt_transcribe 没执行] ${msg(err)}`, failed: true };
    }
    const protocol = this.#protocol();
    const keyName = this.#str('apiKeySecret');
    const key = this.apiKey();
    if (protocol === 'dashscope' && !key) {
      return {
        text: `[stt_transcribe 没执行] 没有配置 ${keyName}：请在控制台「语音转文本 → 状态」里填入密钥（或在部署 .env 里写 ${keyName}=...）。`,
        failed: true,
      };
    }
    const model = this.#str('model');
    if (!model) {
      return { text: '[stt_transcribe 没执行] 没有模型：请在控制台「语音转文本 → 状态」或 worlds.stt.model 里选一个。', failed: true };
    }
    if (protocol === 'dashscope' && !audio.format) {
      return { text: `[stt_transcribe 没执行] 认不出音频格式：${audio.fileName}。换成 wav / mp3 这类常见格式，或补一个正确的扩展名。`, failed: true };
    }
    const language = asText(args.language);
    const hints = language ? [language] : this.#languageHints();
    const context = asText(args.context) || this.#str('context');
    const note = asText(args.note);
    const timeoutMs = this.#num('timeoutMs', 10000, 900000);
    this.#busy += 1;
    try {
      const sampleRate = this.#num('sampleRate', 0, 48000) || audio.sampleRate || 0;
      const res = protocol === 'openai'
        ? await transcribeByOpenAi({
            baseUrl: this.#str('baseUrl'),
            apiKey: key,
            model,
            bytes: audio.bytes,
            mime: audio.mime,
            name: audio.fileName,
            languageHints: hints,
            context,
            timeoutMs,
            signal: ctx?.signal,
          })
        : await transcribeByDashScope({
            baseUrl: this.#str('baseUrl'),
            apiKey: key,
            model,
            bytes: audio.bytes,
            mime: audio.mime,
            format: audio.format,
            sampleRate,
            languageHints: hints,
            context,
            keepDialect: this.#bool('keepDialect'),
            itn: this.#bool('itn'),
            timeoutMs,
            signal: ctx?.signal,
          });
      const seconds = res.seconds ?? audio.seconds;
      const { item, warning } = this.#saveSafe({
        text: res.text,
        note,
        source: { kind: audio.kind, ref: audio.ref },
        model,
        protocol: res.shape,
        language: res.language ?? '',
        seconds,
        audioBytes: audio.bytes.length,
        audioMime: audio.mime,
        format: audio.format ?? '',
        usage: res.usage,
      });
      return this.#outcome({
        text: res.text,
        note,
        item,
        warning,
        audio,
        model,
        language: res.language,
        seconds,
      });
    } catch (err) {
      return this.#failure('stt_transcribe', err);
    } finally {
      this.#busy -= 1;
    }
  }

  #failure(tool, err) {
    const detail = err instanceof SttApiError ? err.message : msg(err);
    this.#lastError = `${new Date().toISOString()} ${detail}`;
    this.#emit({ t: 'error', message: detail, tool }, true);
    return { text: `[${tool} 失败] ${detail}`, failed: true };
  }

  // -------------------------------------------------------------------------
  // 记录与回执
  // -------------------------------------------------------------------------

  #saveSafe(payload) {
    try {
      return { item: this.#storeItem(payload), warning: '' };
    } catch (err) {
      return { item: null, warning: `（记进列表失败，文字只在这条回执里：${msg(err)}）` };
    }
  }

  #storeItem(payload) {
    const item = this.#transcriptsFor().add(payload);
    this.#lastItemAt = item.createdAt;
    this.#emit({ t: 'item', item });
    return item;
  }

  /** 工具回执：文字给模型读；转写没有附件，不产 blob。 */
  #outcome(spec) {
    const body = String(spec.text ?? '');
    const lines = [];
    lines.push(body.trim() ? '转写好了。' : '转写完成，但没识别出文字。');
    lines.push(`来源：${spec.audio.ref}${spec.audio.kind === 'handle' ? '（句柄）' : ''}`);
    const bits = [
      spec.model,
      spec.audio.format,
      spec.language ? `语言 ${spec.language}` : '',
      spec.seconds ? formatSeconds(spec.seconds) : '',
      formatKb(spec.audio.bytes.length),
    ].filter(Boolean);
    lines.push(`参数：${bits.join(' · ')}`);
    if (spec.note) lines.push(`名字：${spec.note}`);
    if (body.trim()) {
      const cut = body.length > 6000 ? `${body.slice(0, 6000)}…（回执截断了，全文在记录里）` : body;
      lines.push(`文字：${cut}`);
    }
    if (spec.warning) lines.push(spec.warning);
    return { text: lines.join('\n') };
  }

  #counts() {
    const transcripts = this.#transcriptsFor();
    return { count: transcripts.count, totalAudioBytes: transcripts.totalAudioBytes };
  }

  // -------------------------------------------------------------------------
  // 控制台
  // -------------------------------------------------------------------------

  console(language = 'zh') {
    this.language = language === 'en' ? 'en' : 'zh';
    const t = this.#text();
    const env = this.#envState();
    const transcripts = this.#transcriptsFor();
    return {
      label: t.label,
      lamps: [{
        label: t.lamp,
        state: env.ok ? 'online' : (env.baseUrl ? 'error' : 'offline'),
        hint: env.detail,
      }],
      badges: [
        { label: t.badgeCount, value: String(transcripts.count), tone: transcripts.count ? 'on' : 'off' },
        { label: t.badgeKey, value: env.keySet ? t.keySet : t.keyUnset, tone: env.keySet ? 'on' : 'off' },
        { label: t.badgeModel, value: env.model || '—', tone: env.model ? 'on' : 'off' },
      ],
      panels: [
        { id: 'transcripts', title: t.panelListTitle, description: t.panelListDesc, getMethods: ['list'] },
        { id: 'status', title: t.panelStatusTitle, description: t.panelStatusDesc, getMethods: ['state'] },
      ],
      config: [configGroup(this.language)],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      stream: (panel, socket) => this.stream(panel, socket),
    };
  }

  async invoke(panel, method, args = []) {
    const list = Array.isArray(args) ? args : [args];
    if (panel === 'transcripts') {
      switch (method) {
        case 'list': return this.#transcriptsFor().summary(list[0]);
        case 'remove': return this.#remove(list[0]);
        case 'clear': return this.#clearAll();
        case 'selftest': return this.#selfTest();
        default: throw new Error(`未知面板方法：transcripts.${method}`);
      }
    }
    if (panel === 'status') {
      switch (method) {
        case 'state': return this.#state();
        case 'setKey': return this.#setKey(list[0]);
        case 'clearKey': return this.#setKey('');
        case 'test': return this.#test(list[0]);
        default: throw new Error(`未知面板方法：status.${method}`);
      }
    }
    throw new Error(`未知面板：${panel}`);
  }

  #state() {
    const env = this.#envState();
    const transcripts = this.#transcriptsFor();
    return {
      language: this.language,
      node: process.version,
      platform: process.platform,
      dir: this.dir(),
      indexFile: transcripts.indexFile,
      keep: transcripts.keep,
      count: transcripts.count,
      totalAudioBytes: transcripts.totalAudioBytes,
      busy: this.#busy > 0,
      lastError: this.#lastError,
      lastItemAt: this.#lastItemAt,
      protocol: this.#protocol(),
      baseUrl: env.baseUrl,
      model: env.model,
      languageHints: this.#str('languageHints'),
      context: this.#str('context'),
      keepDialect: this.#bool('keepDialect'),
      itn: this.#bool('itn'),
      sampleRate: this.#num('sampleRate', 0, 48000),
      maxMb: this.#num('maxMb', 1, 9),
      timeoutMs: this.#num('timeoutMs', 10000, 900000),
      keyName: env.name,
      keySet: env.keySet,
      keyFrom: env.keyFrom,
      keyProvider: env.keyProvider,
      detail: env.detail,
    };
  }

  #setKey(value) {
    const name = this.#str('apiKeySecret');
    const next = typeof value === 'string' ? value.trim() : '';
    try {
      this.storeSecret(name, next);
    } catch (err) {
      throw new Error(`写不进 .env：${msg(err)}`);
    }
    return { ...this.#state(), keyName: name, keySet: Boolean(next), saved: true };
  }

  #remove(ref) {
    const id = asText(ref);
    const ok = this.#transcriptsFor().remove(id);
    if (ok) this.#emit({ t: 'removed', id });
    return { ok, ...this.#counts() };
  }

  #clearAll() {
    const removed = this.#transcriptsFor().clear();
    this.#emit({ t: 'cleared' });
    return { ok: true, removed, ...this.#counts() };
  }

  /** 离线自检：不联网也能验证「入库 → 索引 → 页面」这条路。 */
  #selfTest() {
    const item = this.#storeItem({
      text: '离线自检：没有调用任何语音接口。',
      note: '自检记录',
      source: { kind: 'selftest', ref: 'selftest' },
      model: 'self-test',
      protocol: 'self-test',
      language: '',
      seconds: null,
      audioBytes: 0,
      audioMime: '',
      format: '',
      usage: null,
    });
    return { ok: true, item, ...this.#counts() };
  }

  /** 控制台「试转写」：拿当前配置真转写一个文件，并记进列表。 */
  async #test(value) {
    const ref = asText(value);
    if (!ref) throw new Error('先选一个音频文件。');
    let audio;
    try {
      audio = this.#resolveAudio(ref);
    } catch (err) {
      throw new Error(msg(err));
    }
    const protocol = this.#protocol();
    const key = this.apiKey();
    if (protocol === 'dashscope' && !key) throw new Error(`没有配置 ${this.#str('apiKeySecret')}：先在这个页面填入密钥。`);
    const model = this.#str('model');
    if (!model) throw new Error('先填一个模型（worlds.stt.model）。');
    if (protocol === 'dashscope' && !audio.format) throw new Error('认不出音频格式：换成 wav / mp3 这类常见格式再试。');
    const hints = this.#languageHints();
    const context = this.#str('context');
    const timeoutMs = this.#num('timeoutMs', 10000, 900000);
    const sampleRate = this.#num('sampleRate', 0, 48000) || audio.sampleRate || 0;
    const res = protocol === 'openai'
      ? await transcribeByOpenAi({
          baseUrl: this.#str('baseUrl'),
          apiKey: key,
          model,
          bytes: audio.bytes,
          mime: audio.mime,
          name: audio.fileName,
          languageHints: hints,
          context,
          timeoutMs,
        })
      : await transcribeByDashScope({
          baseUrl: this.#str('baseUrl'),
          apiKey: key,
          model,
          bytes: audio.bytes,
          mime: audio.mime,
          format: audio.format,
          sampleRate,
          languageHints: hints,
          context,
          keepDialect: this.#bool('keepDialect'),
          itn: this.#bool('itn'),
          timeoutMs,
        });
    const item = this.#storeItem({
      text: res.text,
      note: '控制台试转写',
      source: { kind: 'console-test', ref: audio.ref },
      model,
      protocol: res.shape,
      language: res.language ?? '',
      seconds: res.seconds ?? audio.seconds,
      audioBytes: audio.bytes.length,
      audioMime: audio.mime,
      format: audio.format ?? '',
      usage: res.usage,
    });
    return { ok: true, item, ...this.#counts() };
  }

  stream(panel, socket) {
    if (panel !== 'transcripts') {
      try {
        socket.close(`未知面板：${panel}`);
      } catch {
        /* ignore */
      }
      return;
    }
    const peer = {
      send: (frame) => {
        try {
          if (socket.open) socket.send(JSON.stringify(frame));
        } catch {
          /* 连接断了就算了，面板会自己重连。 */
        }
      },
    };
    this.#streams.add(peer);
    try {
      socket.onClose(() => this.#streams.delete(peer));
      socket.onMessage(() => { /* 面板只用 HTTP 请求，回帧不处理。 */ });
    } catch {
      /* 宿主实现不支持回调也不影响单向推送。 */
    }
    peer.send({ t: 'ready', dir: this.dir(), count: this.#transcriptsFor().count });
  }

  #emit(frame, force = false) {
    if (!force && !this.#bool('pushToConsole')) return;
    for (const peer of this.#streams) peer.send(frame);
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(host) {
    this.#host = host;
    try {
      this.#transcriptsFor().ensure();
    } catch (err) {
      this.#host?.log?.warn?.('语音转文本：数据目录建不出来', { err: msg(err) });
    }
    this.#host?.log?.info?.('语音转文本已就绪', {
      dir: this.dir(),
      model: this.#str('model'),
      protocol: this.#protocol(),
      key: this.apiKey() ? '已配置' : '未配置',
    });
  }

  async stop() {
    this.#streams.clear();
    this.#host = null;
  }
}
