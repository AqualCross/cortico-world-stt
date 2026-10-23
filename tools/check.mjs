#!/usr/bin/env node
/**
 * 离线检查：不联网、不碰安装目录。跑法：node tools/check.mjs
 *
 * 覆盖：清单与声明 / 工具声明 / 配置组路径 / 面板声明 / WAV 工具 /
 * 转写记录仓库（入库、索引、裁剪、坏索引容错）/ 接口客户端（打桩 fetch，两种
 * DashScope 请求体 + OpenAI 兼容 multipart）/ 工具整条链（打桩 fetch、打桩宿主）/
 * WebUI bundle 的导出形状与自描述。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'stt-check-'));

let passed = 0;
let failed = 0;
let warned = 0;

const ok = (line) => { passed++; console.log(`  ok    ${line}`); };
const bad = (line) => { failed++; console.log(`  FAIL  ${line}`); };
const hint = (line) => { warned++; console.log(`  提醒  ${line}`); };

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message ?? '不相等'}：${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
function check(label, fn) {
  try {
    fn();
    ok(label);
  } catch (err) {
    bad(`${label} — ${err?.message ?? err}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    bad(`${label} — ${err?.message ?? err}`);
  }
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${ms}ms`);
}

/** 键序无关的 JSON 形态：对比 describe.json 与代码里的声明（与框架的深比较等价）。 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

// ---------------------------------------------------------------------------
// 打桩 fetch
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let calls = [];

function installFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    return handler(u, init);
  };
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}
function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

const ASR_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

const mod = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
const def = mod.default;
const api = await import(pathToFileURL(join(pkgDir, 'src', 'api.js')).href);
const wav = await import(pathToFileURL(join(pkgDir, 'src', 'wav.js')).href);
const transcriptsMod = await import(pathToFileURL(join(pkgDir, 'src', 'transcripts.js')).href);
const config = await import(pathToFileURL(join(pkgDir, 'src', 'config.js')).href);

/** 用定义造一个世界；密钥与目录都可以换。 */
function makeWorld(overrides = {}, opts = {}) {
  const cfg = { ...def.defaults(), enabled: true, ...overrides };
  const stored = [];
  const persisted = [];
  const world = def.create({
    cfg,
    dataDir: opts.dataDir ?? join(scratch, 'data'),
    botDir: opts.botDir ?? join(scratch, 'bot'),
    packageDir: pkgDir,
    secret: () => (opts.key === undefined ? 'sk-test' : opts.key),
    storeSecret: (name, value) => stored.push([name, value]),
    persist: (patch) => persisted.push(structuredClone(patch)),
  });
  world.__stored = stored;
  world.__persisted = persisted;
  return world;
}

/** 事件库 + pushEvent 的假宿主；pushEvent 像 Core 一样补游标。 */
function makeHost(initial = [], blobs = {}) {
  const all = [...initial];
  const events = [];
  const pushed = [];
  const host = {
    store: {
      latestCursor: () => (all.length ? all[all.length - 1].cursor : 0),
      range: ({ fromCursor = 0, limit = 20 } = {}) => all.filter((one) => one.cursor >= fromCursor).slice(0, limit),
    },
    pushEvent: async (e, opts) => {
      events.push(e);
      const full = { ...e, cursor: (all.length ? all[all.length - 1].cursor : 0) + 1 };
      all.push(full);
      pushed.push({ event: e, opts, stored: full });
      return full;
    },
    blob: (handle) => blobs[handle] ?? null,
    log: { info() {}, warn() {} },
  };
  // 既是宿主本身，也带 events / pushed / add：`const { host, events } = makeHost()` 照旧能用。
  return Object.assign(host, {
    host,
    events,
    pushed,
    add(event) {
      const full = { ...event, cursor: (all.length ? all[all.length - 1].cursor : 0) + 1 };
      all.push(full);
      return full;
    },
  });
}

/** 造一个能放音频文件的工作区。 */
function makeWorkspace(name, file, bytes) {
  const botDir = join(scratch, name);
  const wsDir = join(botDir, 'workspace');
  mkdirSync(wsDir, { recursive: true });
  if (file) writeFileSync(join(wsDir, file), bytes);
  return botDir;
}

try {
  // -------------------------------------------------------------------------
  console.log('清单与声明');

  check('package.json 的 cortico 段与 webUiClient', () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    eq(manifest.name, 'cortico-world-stt', 'name');
    eq(manifest.cortico?.kind, 'world', 'kind');
    eq(manifest.cortico?.api, 6, 'api');
    eq(manifest.cortico?.displayName, '语音转文本', 'displayName');
    assert(typeof manifest.cortico?.webUiClient === 'string' && manifest.cortico.webUiClient, '缺 webUiClient');
    assert(existsSync(join(pkgDir, manifest.cortico.webUiClient)), 'webUiClient 文件不在包里');
    eq(manifest.cortico?.describe, 'describe.json', 'describe');
    assert(existsSync(join(pkgDir, 'describe.json')), 'describe.json 不在包里');
    assert(Array.isArray(manifest.files) && manifest.files.includes('describe.json'), 'files 缺 describe.json');
    assert(Array.isArray(manifest.keywords) && manifest.keywords.includes('cortico-world'), 'keywords 缺 cortico-world');
  });

  check('CHANGELOG.md 有当前版本的一节', () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const src = readFileSync(join(pkgDir, 'CHANGELOG.md'), 'utf8');
    const version = String(manifest.version ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert(new RegExp(`^##\\s*\\[?${version}\\]?`, 'm').test(src), `CHANGELOG.md 缺 ## ${manifest.version} 一节`);
    assert(Array.isArray(manifest.files) && manifest.files.includes('CHANGELOG.md'), 'files 缺 CHANGELOG.md');
  });

  check('默认导出是 WorldDefinition', () => {
    eq(def.id, 'stt', 'id');
    eq(def.label, '语音转文本', 'label');
    const defaults = def.defaults();
    eq(defaults.enabled, false, 'enabled 默认 false');
    eq(defaults.protocol, 'dashscope', 'protocol 默认');
    eq(defaults.model, 'qwen3-asr-flash', 'model 默认');
    eq(defaults.maxMb, 7, 'maxMb 默认');
    def.preflight(); // 环境满足时不抛
  });

  check('describe 与 describe.json 一致，实例工具都在声明里', () => {
    assert(def.describe && Array.isArray(def.describe.tools) && def.describe.tools.length === 2, '定义缺 describe.tools');
    assert(Array.isArray(def.describe.events), '定义缺 describe.events');
    const file = JSON.parse(readFileSync(join(pkgDir, 'describe.json'), 'utf8'));
    eq(stable(file), stable(JSON.parse(JSON.stringify(def.describe))), 'describe.json 与代码里的 describe 不一致');
    eq(file.tools[0].name, 'stt_transcribe', 'describe 工具名');
    eq(file.events.length, 2, '异步协议声明两个事件');
    eq(file.events.map((e) => e.type).join(','), 'stt.transcript,stt.transcribe-failed', '事件类型');
    const names = new Set(file.tools.map((t) => t.name));
    for (const tool of makeWorld().tools()) assert(names.has(tool.name), `工具 ${tool.name} 不在 describe.tools 里`);
  });

  check('配置组覆盖 DEFAULTS 的其余键（enabled 由框架开关管理），且都在 worlds.stt 段内', () => {
    const group = config.configGroup('zh');
    const paths = Object.keys(group.schema.properties);
    for (const path of paths) {
      assert(path.startsWith('worlds.stt.'), `配置路径不在 worlds.stt：${path}`);
      const short = path.slice('worlds.stt.'.length);
      assert(Object.hasOwn(config.DEFAULTS, short), `配置 ${short} 没有默认值`);
    }
    for (const short of Object.keys(config.DEFAULTS)) {
      if (short === 'enabled') {
        assert(!paths.includes('worlds.stt.enabled'), 'World 启用开关由框架渲染，不该进配置 schema');
        continue;
      }
      assert(paths.includes(`worlds.stt.${short}`), `默认值 ${short} 没有进 schema`);
    }
  });

  check('不写系统提示词：没有环境段、没有提示词文档', () => {
    const world = makeWorld();
    eq(world.envPromptVars(), null, 'envPromptVars 应为 null');
    const decl = world.webUi('zh');
    assert(!decl.promptDocs || decl.promptDocs.length === 0, '不该再声明提示词文档');
    eq(decl.label, '语音转文本', 'label');
  });

  // -------------------------------------------------------------------------
  console.log('World 与工具');

  check('stt_transcribe 与 stt_watch，声明齐全', () => {
    const world = makeWorld();
    const tools = world.tools();
    eq(tools.length, 2, '工具数量');
    const tool = tools[0];
    eq(tool.name, 'stt_transcribe', '工具名');
    assert(Array.isArray(tool.tags) && tool.tags.includes('read'), 'tags 该是 read');
    eq(tool.interruptible, true, 'interruptible');
    eq(tool.parameters.required?.[0], 'audio', 'required[0]');
    assert(tool.parameters.properties?.audio, '缺 audio 参数');
    assert(tool.parameters.properties?.note, '缺 note 参数');
    assert(tool.parameters.properties?.language, '缺 language 参数');
    assert(tool.parameters.properties?.context, '缺 context 参数');
    const watch = tools[1];
    eq(watch.name, 'stt_watch', '监听工具名');
    assert(Array.isArray(watch.tags) && watch.tags.includes('act'), 'watch tags');
    eq(watch.parameters.required?.[0], 'action', 'watch required[0]');
    assert(watch.parameters.properties?.events, '缺 events 参数');
    assert(watch.parameters.properties?.eventDelivery, '缺 eventDelivery 参数');
  });

  check('面板与配置组声明', () => {
    const world = makeWorld();
    const decl = world.webUi('zh');
    const ids = decl.panels.map((p) => p.id);
    assert(ids.includes('transcripts') && ids.includes('status'), `面板缺：${ids.join(',')}`);
    assert(Array.isArray(decl.config) && decl.config.length === 1, '缺配置组');
    assert(Array.isArray(decl.lamps) && decl.lamps.length === 1, '缺状态灯');
  });

  // -------------------------------------------------------------------------
  console.log('WAV 工具');

  check('样本的时长与采样率能读回来', () => {
    for (const seconds of [0.3, 0.6, 1.2]) {
      const bytes = wav.sampleWav(seconds);
      const info = wav.wavInfo(bytes);
      assert(Math.abs(info.seconds - seconds) < 0.02, `${seconds}s 读成 ${info.seconds}s`);
      eq(info.sampleRate, 24000, '采样率');
      eq(info.channels, 1, '声道');
    }
  });

  check('认不出的字节给 null', () => {
    eq(wav.wavInfo(Buffer.from('not a wav at all')), null, '文本不是 wav');
    eq(wav.wavDuration(Buffer.alloc(0)), null, '空缓冲');
  });

  // -------------------------------------------------------------------------
  console.log('转写记录仓库');

  check('入库、索引、裁剪、坏索引容错', () => {
    const dir = join(scratch, 'records');
    const store = new transcriptsMod.Transcripts({ dir, keep: 2 });
    store.add({ text: '一', note: 'a', source: { kind: 'file', ref: 'C:/x/1.wav' }, audioBytes: 100 });
    store.add({ text: '二' });
    store.add({ text: '三', seconds: 1.5, language: 'zh', audioBytes: 200 });
    eq(store.count, 2, 'keep=2 后的条数');
    assert(store.list().some((i) => i.text === '三'), '最新的没留下');
    assert(!store.list().some((i) => i.text === '一'), '最旧的没被裁掉');
    assert(existsSync(store.indexFile), '索引没落盘');
    eq(store.totalAudioBytes, 200, '源音频总大小');

    const again = new transcriptsMod.Transcripts({ dir, keep: 2 });
    eq(again.count, 2, '重载索引后的条数');
    const first = again.list()[0];
    eq(first.seconds, 1.5, '秒数没持久化');
    eq(first.language, 'zh', '语言没持久化');
    assert(again.get(first.id)?.text === '三', '按 id 取不回来');
    assert(again.remove(first.id) && again.count === 1, '删除没生效');

    writeFileSync(join(dir, 'index.json'), '{oops');
    eq(new transcriptsMod.Transcripts({ dir, keep: 2 }).count, 0, '坏索引应当当空');
  });

  // -------------------------------------------------------------------------
  console.log('接口客户端');

  await checkAsync('qwen-audio 请求体：input_audio + parameters.format，响应取 output.text', async () => {
    const body = wav.sampleWav(0.2);
    installFetch((u) => {
      if (u.endsWith(ASR_PATH)) {
        return jsonRes({
          request_id: 'req-1',
          output: {
            text: '你好世界。',
            sentence: { sentence_id: 1, sentence_end: true, text: '你好世界。' },
          },
          usage: { duration: 4, input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      }
      throw new Error(`没料到的请求：${u}`);
    });
    try {
      const res = await api.transcribeByDashScope({
        baseUrl: 'https://dashscope.test',
        apiKey: 'sk-1',
        model: 'qwen-audio-3.1-asr-flash',
        bytes: body,
        mime: 'audio/wav',
        format: 'wav',
        sampleRate: 24000,
        languageHints: ['zh', 'en'],
        context: '专有名词：本鲸。',
        keepDialect: true,
        itn: true,
      });
      const post = calls.find((c) => c.init?.method === 'POST');
      assert(post, '没有发 POST');
      eq(post.url, 'https://dashscope.test' + ASR_PATH, '接口地址');
      eq(post.init.headers.Authorization, 'Bearer sk-1', 'Authorization');
      const sent = JSON.parse(post.init.body);
      eq(sent.model, 'qwen-audio-3.1-asr-flash', 'model');
      const messages = sent.input.messages;
      eq(messages.length, 2, '上下文消息在前');
      eq(messages[0].role, 'user', '上下文角色');
      eq(messages[0].content[0].type, 'input_text', '上下文类型');
      eq(messages[0].content[0].text, '专有名词：本鲸。', '上下文文本');
      const audioMsg = messages.at(-1);
      eq(audioMsg.content[0].type, 'input_audio', '音频消息类型');
      assert(audioMsg.content[0].input_audio.data.startsWith('data:audio/wav;base64,'), '音频应是 data URI');
      eq(sent.parameters.format, 'wav', 'parameters.format');
      eq(sent.parameters.sample_rate, '24000', 'parameters.sample_rate');
      eq(JSON.stringify(sent.parameters.language_hints), '["zh","en"]', 'language_hints');
      eq(sent.parameters.keep_dialect, true, 'keep_dialect');
      assert(sent.parameters.enable_itn === undefined, 'qwen-audio 不该发 ITN');
      assert(sent.parameters.asr_options === undefined, 'qwen-audio 不该发 asr_options');
      eq(res.text, '你好世界。', 'text');
      eq(res.shape, 'qwen-audio', 'shape');
      eq(res.seconds, 4, 'seconds');
      eq(res.usage.total_tokens, 15, 'usage');
      eq(res.language, null, 'qwen-audio 响应没有语言字段');
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('qwen3-asr 分派：content.audio + asr_options，响应 content 数组与语言标注', async () => {
    const body = wav.sampleWav(0.2);
    let sent = null;
    installFetch((u, init) => {
      if (u.endsWith(ASR_PATH)) {
        sent = JSON.parse(init.body);
        return jsonRes({
          output: {
            choices: [{
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Hello world.' }],
                annotations: [{ type: 'audio_info', language: 'en', emotion: 'neutral' }],
              },
            }],
          },
          usage: { seconds: 3, total_tokens: 42 },
        });
      }
      throw new Error(`没料到的请求：${u}`);
    });
    try {
      const res = await api.transcribeByDashScope({
        baseUrl: 'https://dashscope.test',
        apiKey: 'sk-1',
        model: 'qwen3-asr-flash',
        bytes: body,
        mime: 'audio/wav',
        format: 'wav',
        languageHints: ['en'],
        itn: true,
        keepDialect: true,
      });
      assert(sent, '没有发 POST');
      eq(sent.input.messages.length, 1, 'qwen3 不带上下文时只有音频一条');
      assert(sent.input.messages[0].content[0].audio.startsWith('data:audio/wav;base64,'), 'qwen3 音频应是 data URI');
      eq(sent.parameters.asr_options.language, 'en', 'asr_options.language');
      eq(sent.parameters.asr_options.enable_itn, true, 'asr_options.enable_itn');
      assert(sent.parameters.format === undefined, 'qwen3 不该发 format');
      assert(sent.parameters.keep_dialect === undefined, 'qwen3 不该发 keep_dialect');
      eq(res.text, 'Hello world.', 'text');
      eq(res.language, 'en', '语言标注');
      eq(res.seconds, 3, 'seconds');
      eq(res.shape, 'qwen3', 'shape');
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('失败路径：状态码与提示；没有结果字段也算失败', async () => {
    const body = wav.sampleWav(0.2);
    const cases = [
      { status: 401, json: { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, want: '密钥' },
      { status: 404, json: { code: 'ModelNotFound', message: 'nope' }, want: '接口地址' },
      { status: 429, json: { code: 'Throttling', message: 'Requests rate limit exceeded' }, want: '限流' },
      { status: 400, json: { code: 'InvalidParameter', message: 'audio format not supported' }, want: '格式' },
      { status: 400, json: { code: 'InvalidParameter', message: 'url error, please check url！ For details, see: https://help.aliyun.com/zh/model-studio/error-code#error-url' }, want: '地址' },
      { status: 400, json: { code: 'InvalidParameter', message: 'Model not exist.' }, want: '模型' },
    ];
    for (const one of cases) {
      installFetch(() => jsonRes(one.json, one.status));
      try {
        await api.transcribeByDashScope({
          baseUrl: 'https://dashscope.test', apiKey: 'k', model: 'm', bytes: body, mime: 'audio/wav', format: 'wav',
        });
        throw new Error(`HTTP ${one.status} 应当抛错`);
      } catch (err) {
        assert(err instanceof api.SttApiError, `不是 SttApiError：${err?.name}`);
        eq(err.status, one.status, 'status');
        assert(err.message.includes(one.want), `提示里没有「${one.want}」：${err.message}`);
      } finally {
        restoreFetch();
      }
    }
    installFetch(() => jsonRes({ request_id: 'r', output: {} }));
    try {
      await api.transcribeByDashScope({
        baseUrl: 'https://dashscope.test', apiKey: 'k', model: 'm', bytes: body, mime: 'audio/wav', format: 'wav',
      });
      throw new Error('没有结果应当抛错');
    } catch (err) {
      assert(err instanceof api.SttApiError && err.message.includes('接口没给识别结果'), `错误不对：${err?.message}`);
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('OpenAI 兼容形态：multipart、地址拼接、响应解析', async () => {
    const body = wav.sampleWav(0.2);
    const seen = [];
    installFetch((u, init) => {
      seen.push({ u, init });
      if (u === 'http://127.0.0.1:9000/v1/audio/transcriptions') {
        return jsonRes({ text: '你好呀', language: 'zh', duration: 1.2 });
      }
      if (u === 'http://127.0.0.1:9000/text-mode/v1/audio/transcriptions') {
        return new Response('纯文本结果', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      throw new Error(`没料到的请求：${u}`);
    });
    try {
      const res = await api.transcribeByOpenAi({
        baseUrl: 'http://127.0.0.1:9000',
        model: 'whisper-1',
        bytes: body,
        mime: 'audio/wav',
        name: 'hello.wav',
        languageHints: ['zh'],
        context: '本鲸',
      });
      const post = seen.find((c) => c.init?.method === 'POST');
      assert(post, '没有发 POST');
      assert(post.init.body instanceof FormData, '请求体应是 FormData');
      eq(post.init.body.get('model'), 'whisper-1', 'model');
      eq(post.init.body.get('response_format'), 'json', 'response_format');
      eq(post.init.body.get('language'), 'zh', 'language');
      eq(post.init.body.get('prompt'), '本鲸', 'prompt');
      const file = post.init.body.get('file');
      assert(file instanceof Blob, 'file 应是 Blob');
      eq(file.name, 'hello.wav', '文件名');
      eq(post.init.headers.Authorization, undefined, '没 key 就不带 Authorization');
      eq(res.text, '你好呀', 'text');
      eq(res.language, 'zh', 'language');
      eq(res.seconds, 1.2, 'duration');
      eq(res.shape, 'openai', 'shape');

      const res2 = await api.transcribeByOpenAi({ baseUrl: 'http://127.0.0.1:9000/text-mode', bytes: body, mime: 'audio/wav' });
      eq(res2.text, '纯文本结果', '纯文本响应也要认');
      const withKey = await api.transcribeByOpenAi({ baseUrl: 'http://127.0.0.1:9000', apiKey: 'tok', bytes: body, mime: 'audio/wav' });
      const last = seen.at(-1);
      eq(last.init.headers.Authorization, 'Bearer tok', '带 key 时要有 Authorization');
      eq(withKey.text, '你好呀', '再次请求');
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('OpenAI 形态的失败提示', async () => {
    const body = wav.sampleWav(0.2);
    installFetch(() => jsonRes({ error: { message: 'Invalid API key' } }, 401));
    try {
      await api.transcribeByOpenAi({ baseUrl: 'http://127.0.0.1:9000', bytes: body, mime: 'audio/wav' });
      throw new Error('401 应当抛错');
    } catch (err) {
      assert(err instanceof api.SttApiError, `不是 SttApiError：${err?.name}`);
      eq(err.status, 401, 'status');
      assert(err.message.includes('密钥'), `401 提示不对：${err?.message}`);
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('异步文件转写：取凭证 → 上传 → 提交 → 查询 → 下载结果', async () => {
    const body = wav.sampleWav(0.2);
    const seen = [];
    installFetch((u, init) => {
      seen.push({ u, init });
      if (u === 'https://dashscope.test/api/v1/uploads?action=getPolicy&model=filetrans-x') {
        return jsonRes({
          data: {
            policy: 'p',
            signature: 's',
            upload_host: 'https://upload.test',
            upload_dir: 'dashscope-instant/abc',
            oss_access_key_id: 'AK',
            x_oss_object_acl: 'private',
            x_oss_forbid_overwrite: 'true',
          },
        });
      }
      if (u === 'https://upload.test') return new Response('', { status: 200 });
      if (u === 'https://dash.test/api/v1/services/audio/asr/transcription') {
        return jsonRes({ output: { task_id: 't1', task_status: 'PENDING' }, request_id: 'r1' });
      }
      if (u === 'https://dash.test/api/v1/tasks/t1') {
        return jsonRes({
          output: {
            task_id: 't1',
            task_status: 'SUCCEEDED',
            results: [{ subtask_status: 'SUCCEEDED', transcription_url: 'https://result.test/r.json' }],
          },
          usage: { duration: 3 },
        });
      }
      if (u === 'https://result.test/r.json') {
        return jsonRes({
          properties: { original_duration_in_milliseconds: 3200 },
          transcripts: [{ text: '你好。' }, { text: '第二段。' }],
        });
      }
      throw new Error(`没料到的请求：${u}`);
    });
    try {
      const up = await api.uploadToDashScope({
        apiKey: 'sk-1',
        model: 'filetrans-x',
        bytes: body,
        name: '语音 1.wav',
        mime: 'audio/wav',
        uploadBaseUrl: 'https://dashscope.test',
      });
      eq(up.fileUrl, 'oss://dashscope-instant/abc/语音_1.wav', '临时 URL');
      const upload = seen.find((c) => c.u === 'https://upload.test');
      assert(upload.init.body instanceof FormData, '上传应是 multipart');
      eq(upload.init.body.get('key'), 'dashscope-instant/abc/语音_1.wav', 'key');
      eq(upload.init.body.get('OSSAccessKeyId'), 'AK', 'AccessKeyId');
      eq(upload.init.body.get('Signature'), 's', 'Signature');
      assert(upload.init.body.get('file') instanceof Blob, 'file 应是 Blob');
      const policy = seen.find((c) => c.u.includes('/api/v1/uploads'));
      eq(policy.init.headers.Authorization, 'Bearer sk-1', '凭证接口的 Authorization');

      const sub = await api.submitDashScopeAsync({
        baseUrl: 'https://dash.test',
        apiKey: 'sk-1',
        model: 'filetrans-x',
        fileUrl: up.fileUrl,
        languageHints: ['zh', 'en'],
      });
      eq(sub.taskId, 't1', 'task_id');
      const post = seen.find((c) => c.u.endsWith('/audio/asr/transcription'));
      eq(post.init.headers['X-DashScope-Async'], 'enable', '异步头');
      eq(post.init.headers['X-DashScope-OssResourceResolve'], 'enable', 'oss 解析头');
      const sent = JSON.parse(post.init.body);
      eq(sent.model, 'filetrans-x', 'model');
      eq(JSON.stringify(sent.input.file_urls), '["oss://dashscope-instant/abc/语音_1.wav"]', 'file_urls');
      eq(JSON.stringify(sent.parameters.channel_id), '[0]', 'channel_id');
      eq(JSON.stringify(sent.parameters.language_hints), '["zh","en"]', 'language_hints');

      const task = await api.queryDashScopeTask({ baseUrl: 'https://dash.test', apiKey: 'sk-1', taskId: 't1' });
      eq(task.status, 'SUCCEEDED', '任务状态');
      eq(task.usage.duration, 3, 'usage');
      const res = await api.fetchDashScopeTranscript(task.transcriptionUrl);
      eq(res.text, '你好。\n第二段。', '多段拼接');
      eq(res.seconds, 3.2, '结果里的时长');
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('异步提交 404：提示换成工作空间地址', async () => {
    const body = wav.sampleWav(0.2);
    installFetch((u) => {
      if (u.includes('/api/v1/uploads')) {
        return jsonRes({
          data: {
            policy: 'p', signature: 's', upload_host: 'https://upload.test',
            upload_dir: 'd', oss_access_key_id: 'AK',
          },
        });
      }
      if (u === 'https://upload.test') return new Response('', { status: 200 });
      return jsonRes({ message: 'not found' }, 404);
    });
    try {
      const up = await api.uploadToDashScope({ apiKey: 'k', model: 'm', bytes: body, uploadBaseUrl: 'https://dashscope.test' });
      await api.submitDashScopeAsync({ baseUrl: 'https://dash.test', apiKey: 'k', model: 'm', fileUrl: up.fileUrl });
      throw new Error('404 应当抛错');
    } catch (err) {
      assert(err instanceof api.SttApiError, `不是 SttApiError：${err?.name}`);
      assert(err.message.includes('工作空间'), `404 提示不对：${err?.message}`);
    } finally {
      restoreFetch();
    }
  });

  // -------------------------------------------------------------------------
  console.log('工具整条链');

  await checkAsync('转写 → 记录 → 回执（文件路径输入）', async () => {
    const body = wav.sampleWav(0.4);
    const botDir = makeWorkspace('bot-a', 'hello.wav', body);
    const world = makeWorld({ model: 'qwen-audio-3.1-asr-flash' }, { dataDir: join(scratch, 'data-a'), botDir });
    installFetch((u, init) => {
      if (u.endsWith(ASR_PATH)) {
        return jsonRes({
          request_id: 'r2',
          output: { text: '你好，本鲸。', sentence: { text: '你好，本鲸。' } },
          usage: { duration: 0.4 },
        });
      }
      throw new Error(`没料到的请求：${u}`);
    });
    try {
      const tool = world.tools()[0];
      const out = await tool.handler({ audio: 'hello.wav', note: '演示' }, {});
      assert(!out.failed, `不该失败：${out.text}`);
      assert(out.text.includes('转写好了'), '回执缺字样');
      assert(out.text.includes('文字：你好，本鲸。'), '回执没有文字');
      assert(!out.blobs, '转写回执不该带 blob');
      assert(out.text.includes('hello.wav'), '回执没有来源');
      const post = calls.find((c) => c.init?.method === 'POST');
      const sent = JSON.parse(post.init.body);
      eq(sent.input.messages.at(-1).content[0].type, 'input_audio', '请求体没走 input_audio');
      assert(sent.input.messages.at(-1).content[0].input_audio.data.startsWith('data:audio/wav;base64,'), '音频没编码');
      eq(sent.parameters.sample_rate, '24000', 'wav 头里的采样率该发出去');
      const summary = await world.invoke('transcripts', 'list', [10]);
      eq(summary.count, 1, '记录条数');
      eq(summary.items[0].text, '你好，本鲸。', '记录文本');
      eq(summary.items[0].source.kind, 'file', '来源类型');
      eq(summary.items[0].audioBytes, body.length, '源音频大小');
      eq(summary.items[0].seconds, 0.4, '时长');
      assert(existsSync(summary.indexFile), '索引没落盘');
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('句柄输入：走宿主 blob；解析不了要给出人话', async () => {
    const body = wav.sampleWav(0.3);
    const world = makeWorld({ model: 'qwen-audio-3.1-asr-flash' }, { dataDir: join(scratch, 'data-b') });
    const { host } = makeHost([], { 'mem:ok.wav': { bytes: new Uint8Array(body), mime: 'audio/wav' } });
    await world.start(host);
    installFetch(() => jsonRes({ output: { text: '来自句柄。' } }));
    try {
      const tool = world.tools()[0];
      const out = await tool.handler({ audio: 'mem:ok.wav' }, {});
      assert(!out.failed, `不该失败：${out.text}`);
      assert(out.text.includes('来源：mem:ok.wav（句柄）'), '句柄来源没标出来');
      assert(out.text.includes('来自句柄。'), '回执没有文字');
      const bad = await tool.handler({ audio: 'log:nope.wav' }, {});
      assert(bad.failed && bad.text.includes('句柄'), `坏句柄的回执不对：${bad.text}`);
      await world.stop();
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('缺密钥 / 空输入 / 找不到文件 / 认不出格式 / 超过上限：不联网就失败', async () => {
    installFetch(() => {
      throw new Error('不该联网');
    });
    try {
      const botDir = makeWorkspace('bot-c', 'ok.wav', wav.sampleWav(0.2));
      const noKey = makeWorld({}, { dataDir: join(scratch, 'data-c1'), botDir, key: '' });
      const out1 = await noKey.tools()[0].handler({ audio: 'ok.wav' }, {});
      assert(out1.failed && out1.text.includes('没有配置'), `缺密钥的回执不对：${out1.text}`);

      const world = makeWorld({}, { dataDir: join(scratch, 'data-c2'), botDir });
      const out2 = await world.tools()[0].handler({ audio: '   ' }, {});
      assert(out2.failed && out2.text.includes('audio 是空的'), `空输入的回执不对：${out2.text}`);
      const out3 = await world.tools()[0].handler({ audio: 'nope.wav' }, {});
      assert(out3.failed && out3.text.includes('找不到音频文件'), `找不到文件的回执不对：${out3.text}`);

      const botDir2 = makeWorkspace('bot-c3', 'mystery.xyz', Buffer.from('not audio at all'));
      const world2 = makeWorld({}, { dataDir: join(scratch, 'data-c3'), botDir: botDir2 });
      const out4 = await world2.tools()[0].handler({ audio: 'mystery.xyz' }, {});
      assert(out4.failed && out4.text.includes('认不出音频格式'), `认不出格式的回执不对：${out4.text}`);

      const botDir3 = makeWorkspace('bot-c4', 'big.wav', Buffer.alloc(1.5 * 1024 * 1024));
      const world3 = makeWorld({ maxMb: 1 }, { dataDir: join(scratch, 'data-c4'), botDir: botDir3 });
      const out5 = await world3.tools()[0].handler({ audio: 'big.wav' }, {});
      assert(out5.failed && out5.text.includes('超过上限'), `超限的回执不对：${out5.text}`);
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('openai 协议：没 key 也能转，体是 multipart', async () => {
    const body = wav.sampleWav(0.2);
    const botDir = makeWorkspace('bot-d', 'voice.wav', body);
    const world = makeWorld({
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:9000',
      model: 'whisper-1',
    }, { dataDir: join(scratch, 'data-d'), botDir, key: '' });
    installFetch((u, init) => {
      if (u === 'http://127.0.0.1:9000/v1/audio/transcriptions') {
        assert(init.body instanceof FormData, '应当走 multipart');
        return jsonRes({ text: '它说话了。' });
      }
      throw new Error(`没料到的请求：${u}`);
    });
    try {
      const out = await world.tools()[0].handler({ audio: 'voice.wav' }, {});
      assert(!out.failed, `不该失败：${out.text}`);
      assert(out.text.includes('文字：它说话了。'), '回执没有文字');
      const summary = await world.invoke('transcripts', 'list', [10]);
      eq(summary.items[0].protocol, 'openai', '协议没记上');
    } finally {
      restoreFetch();
    }
  });

  // -------------------------------------------------------------------------
  console.log('异步协议');

  function makeAsyncWorld(dataDir, botDir, overrides = {}) {
    return new mod.SttWorld({
      cfg: {
        ...def.defaults(),
        enabled: true,
        protocol: 'dashscope-async',
        model: 'qwen3-asr-flash-filetrans',
        baseUrl: 'https://dash.test',
        ...overrides,
      },
      dataDir,
      botDir: botDir ?? join(scratch, 'bot-async'),
      secret: () => 'sk-test',
      storeSecret: () => {},
      pollMs: 5,
    });
  }

  const ASYNC_PATH = '/api/v1/services/audio/asr/transcription';

  await checkAsync('提交即回执，轮询完成后发事件并记录', async () => {
    const body = wav.sampleWav(0.4);
    const botDir = makeWorkspace('bot-e', 'talk.wav', body);
    const world = makeAsyncWorld(join(scratch, 'data-e'), botDir);
    const { host, events } = makeHost();
    installFetch((u) => {
      if (u.startsWith('https://dashscope.aliyuncs.com/api/v1/uploads')) {
        return jsonRes({
          data: {
            policy: 'p', signature: 's', upload_host: 'https://upload.test',
            upload_dir: 'dir', oss_access_key_id: 'AK',
          },
        });
      }
      if (u === 'https://upload.test') return new Response('', { status: 200 });
      if (u.endsWith(ASYNC_PATH)) return jsonRes({ output: { task_id: 't9' } });
      if (u === 'https://dash.test/api/v1/tasks/t9') {
        return jsonRes({
          output: {
            task_id: 't9',
            task_status: 'SUCCEEDED',
            results: [{ subtask_status: 'SUCCEEDED', transcription_url: 'https://result.test/t9.json' }],
          },
          usage: { duration: 0.4 },
        });
      }
      if (u === 'https://result.test/t9.json') {
        return jsonRes({
          properties: { original_duration_in_milliseconds: 400 },
          transcripts: [{ text: '异步结果。' }],
        });
      }
      throw new Error(`没料到的请求：${u}`);
    });
    try {
      await world.start(host);
      const out = await world.tools()[0].handler({ audio: 'talk.wav', note: '演示' }, {});
      assert(!out.failed, `不该失败：${out.text}`);
      assert(out.text.includes('已提交') && out.text.includes('t9'), `回执不对：${out.text}`);
      await waitFor(() => events.length > 0);
      eq(events[0].type, 'stt.transcript', '事件类型');
      assert(events[0].text.includes('异步结果。'), '事件正文没带文字');
      eq(events[0].meta.taskId, 't9', 'meta.taskId');
      const summary = await world.invoke('transcripts', 'list', [10]);
      eq(summary.items[0].text, '异步结果。', '记录文本');
      eq(summary.items[0].protocol, 'filetrans', '协议');
      eq(summary.items[0].seconds, 0.4, '时长');
      eq((await world.invoke('status', 'state')).pending, 0, '在途任务应清空');
      eq(readFileSync(join(scratch, 'data-e', 'stt', 'pending.json'), 'utf8').includes('t9'), false, '任务号应落盘再清掉');
      await world.stop();
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('重启后在途任务接着轮询', async () => {
    const dataDir = join(scratch, 'data-f');
    const dir = join(dataDir, 'stt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pending.json'), JSON.stringify({
      version: 1,
      tasks: [{
        id: 'x1',
        taskId: 't2',
        model: 'qwen3-asr-flash-filetrans',
        note: '旧的',
        source: { kind: 'file', ref: 'old.wav' },
        audio: { name: 'old.wav', bytes: 1000, mime: 'audio/wav', format: 'wav', seconds: 1 },
        submittedAt: new Date(Date.now() - 60000).toISOString(),
        deadlineAt: new Date(Date.now() + 600000).toISOString(),
        baseUrl: 'https://dash.test',
        languageHints: [],
      }],
    }));
    const world = makeAsyncWorld(dataDir);
    const { host, events } = makeHost();
    installFetch((u) => {
      if (u === 'https://dash.test/api/v1/tasks/t2') {
        return jsonRes({
          output: {
            task_id: 't2',
            task_status: 'SUCCEEDED',
            results: [{ subtask_status: 'SUCCEEDED', transcription_url: 'https://result.test/t2.json' }],
          },
        });
      }
      if (u === 'https://result.test/t2.json') return jsonRes({ transcripts: [{ text: '接着来的结果。' }] });
      throw new Error(`没料到的请求：${u}`);
    });
    try {
      eq((await world.invoke('status', 'state')).pending, 1, '启动前应看到在途任务');
      await world.start(host);
      await waitFor(() => events.length > 0);
      assert(events[0].text.includes('接着来的结果。'), '恢复后的事件不对');
      eq((await world.invoke('status', 'state')).pending, 0, '在途任务应清空');
      await world.stop();
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('任务失败：发失败事件并清掉在途任务', async () => {
    const dataDir = join(scratch, 'data-g');
    const dir = join(dataDir, 'stt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pending.json'), JSON.stringify({
      version: 1,
      tasks: [{
        taskId: 't3',
        model: 'qwen3-asr-flash-filetrans',
        source: { kind: 'file', ref: 'bad.wav' },
        submittedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 600000).toISOString(),
        baseUrl: 'https://dash.test',
      }],
    }));
    const world = makeAsyncWorld(dataDir);
    const { host, events } = makeHost();
    installFetch(() => jsonRes({
      output: {
        task_id: 't3',
        task_status: 'FAILED',
        results: [{ subtask_status: 'FAILED', code: 'InvalidFile', message: '坏文件' }],
      },
    }));
    try {
      await world.start(host);
      await waitFor(() => events.length > 0);
      eq(events[0].type, 'stt.transcribe-failed', '事件类型');
      assert(events[0].text.includes('坏文件'), '事件正文没带原因');
      const state = await world.invoke('status', 'state');
      eq(state.pending, 0, '在途任务应清空');
      assert(state.lastError.includes('坏文件'), 'status 里应该有最近错误');
      await world.stop();
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('在途任务过期：不联查，直接发失败事件', async () => {
    const dataDir = join(scratch, 'data-h');
    const dir = join(dataDir, 'stt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pending.json'), JSON.stringify({
      version: 1,
      tasks: [{
        taskId: 't4',
        model: 'qwen3-asr-flash-filetrans',
        source: { kind: 'file', ref: 'slow.wav' },
        submittedAt: new Date(Date.now() - 200000).toISOString(),
        deadlineAt: new Date(Date.now() - 1000).toISOString(),
        baseUrl: 'https://dash.test',
      }],
    }));
    const world = makeAsyncWorld(dataDir);
    const { host, events } = makeHost();
    installFetch(() => {
      throw new Error('过期任务不该再联网');
    });
    try {
      await world.start(host);
      await waitFor(() => events.length > 0);
      eq(events[0].type, 'stt.transcribe-failed', '事件类型');
      assert(events[0].text.includes('timeoutMs'), '失败原因该提到期限');
      eq((await world.invoke('status', 'state')).pending, 0, '在途任务应清空');
      await world.stop();
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('同步协议 + 工具参数 event：立即回执，后台完成后发事件', async () => {
    const body = wav.sampleWav(0.4);
    const botDir = makeWorkspace('bot-i', 'say.wav', body);
    const world = makeWorld({}, { dataDir: join(scratch, 'data-i'), botDir });
    const { host, events } = makeHost();
    installFetch((u) => {
      if (u.endsWith(ASR_PATH)) {
        return jsonRes({
          output: { choices: [{ message: { content: [{ type: 'text', text: '后台文字。' }] } }] },
        });
      }
      throw new Error(`没料到的请求：${u}`);
    });
    try {
      await world.start(host);
      const out = await world.tools()[0].handler({ audio: 'say.wav', delivery: 'event' }, {});
      assert(!out.failed && out.text.includes('已提交'), `回执不对：${out.text}`);
      await waitFor(() => events.length > 0);
      eq(events[0].type, 'stt.transcript', '事件类型');
      assert(events[0].text.includes('后台文字。'), '事件正文没带文字');
      const summary = await world.invoke('transcripts', 'list', [10]);
      eq(summary.items[0].text, '后台文字。', '记录文本');
      eq((await world.invoke('status', 'state')).pending, 0, '在途任务应清空');
      await world.stop();
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('异步协议 + wait：在调用里等到文字，不发事件', async () => {
    const body = wav.sampleWav(0.4);
    const botDir = makeWorkspace('bot-j', 'wait.wav', body);
    const world = makeAsyncWorld(join(scratch, 'data-j'), botDir, { delivery: 'wait' });
    const { host, events } = makeHost();
    installFetch((u) => {
      if (u.startsWith('https://dashscope.aliyuncs.com/api/v1/uploads')) {
        return jsonRes({
          data: {
            policy: 'p', signature: 's', upload_host: 'https://upload.test',
            upload_dir: 'dir', oss_access_key_id: 'AK',
          },
        });
      }
      if (u === 'https://upload.test') return new Response('', { status: 200 });
      if (u.endsWith(ASYNC_PATH)) return jsonRes({ output: { task_id: 'tw' } });
      if (u === 'https://dash.test/api/v1/tasks/tw') {
        return jsonRes({
          output: {
            task_id: 'tw',
            task_status: 'SUCCEEDED',
            results: [{ subtask_status: 'SUCCEEDED', transcription_url: 'https://result.test/tw.json' }],
          },
        });
      }
      if (u === 'https://result.test/tw.json') return jsonRes({ transcripts: [{ text: '等待结果。' }] });
      throw new Error(`没料到的请求：${u}`);
    });
    try {
      await world.start(host);
      const out = await world.tools()[0].handler({ audio: 'wait.wav' }, {});
      assert(!out.failed, `不该失败：${out.text}`);
      assert(out.text.includes('转写好了') && out.text.includes('等待结果。'), `回执不对：${out.text}`);
      eq(events.length, 0, '阻塞式不该再发事件');
      eq((await world.invoke('status', 'state')).pending, 0, '不该留下在途任务');
      await world.stop();
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('重启时后台同步请求：发失败事件', async () => {
    const dataDir = join(scratch, 'data-k');
    const dir = join(dataDir, 'stt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pending.json'), JSON.stringify({
      version: 1,
      tasks: [{
        id: 'r1',
        kind: 'request',
        model: 'qwen3-asr-flash',
        source: { kind: 'file', ref: 'gone.wav' },
        submittedAt: new Date(Date.now() - 60000).toISOString(),
        deadlineAt: new Date(Date.now() + 600000).toISOString(),
      }],
    }));
    const world = makeAsyncWorld(dataDir, undefined, { protocol: 'dashscope' });
    const { host, events } = makeHost();
    installFetch(() => {
      throw new Error('重启后的请求不该再联网');
    });
    try {
      eq((await world.invoke('status', 'state')).pending, 1, '启动前应看到在途请求');
      await world.start(host);
      await waitFor(() => events.length > 0);
      eq(events[0].type, 'stt.transcribe-failed', '事件类型');
      assert(events[0].text.includes('应用重启'), '失败原因不对');
      eq((await world.invoke('status', 'state')).pending, 0, '在途请求应清空');
      await world.stop();
    } finally {
      restoreFetch();
    }
  });

  // -------------------------------------------------------------------------
  console.log('监听事件音频');

  const makeWatchWorld = (dataDir, botDir, overrides = {}) => new mod.SttWorld({
    cfg: { ...def.defaults(), enabled: true, ...overrides },
    dataDir,
    botDir,
    secret: () => 'sk-test',
    storeSecret: () => {},
    persist: () => {},
    scanMs: 20,
  });

  const asrText = (text) => (u) => {
    if (u.endsWith(ASR_PATH)) {
      return jsonRes({ output: { choices: [{ message: { content: [{ type: 'text', text }] } }] } });
    }
    throw new Error(`没料到的请求：${u}`);
  };

  await checkAsync('stt_watch 读状态、开关与事件去向都写回配置', async () => {
    const world = makeWorld();
    const watch = world.tools()[1];
    const status = await watch.handler({ action: 'status' }, {});
    assert(status.text.includes('自动转写：off') && status.text.includes('listen.chunk') && status.text.includes('model'), status.text);
    const started = await watch.handler({ action: 'start', events: 'listen.chunk, other.audio' }, {});
    assert(!started.failed, started.text);
    eq(world.cfg.autoTranscribe, true, 'autoTranscribe');
    eq(world.cfg.watchEvents, 'listen.chunk, other.audio', 'watchEvents');
    const set = await watch.handler({ action: 'set', eventDelivery: 'archive' }, {});
    assert(!set.failed, set.text);
    eq(world.cfg.eventDelivery, 'archive', 'eventDelivery');
    eq(world.cfg.autoTranscribe, true, 'set 不该改开关');
    eq(JSON.stringify(world.__persisted), JSON.stringify([
      { autoTranscribe: true, watchEvents: 'listen.chunk, other.audio' },
      { eventDelivery: 'archive' },
    ]), 'persist patch');
    const stopped = await watch.handler({ action: 'stop' }, {});
    assert(!stopped.failed, stopped.text);
    eq(world.cfg.autoTranscribe, false, 'stop');
    const bad = await watch.handler({ action: 'set', eventDelivery: 'nope' }, {});
    assert(bad.failed, '非法 eventDelivery 应当失败');
    const empty = await watch.handler({ action: 'set' }, {});
    assert(empty.failed, 'set 不给参数应当失败');
  });

  await checkAsync('监听：只转写打开之后的新事件，音频句柄来自事件附件', async () => {
    const body = wav.sampleWav(0.4);
    const blobs = {
      'log:old.wav': { bytes: new Uint8Array(body), mime: 'audio/wav' },
      'log:new.wav': { bytes: new Uint8Array(body), mime: 'audio/wav' },
    };
    const host = makeHost([{
      cursor: 1,
      type: 'listen.chunk',
      source: 'listen',
      text: '',
      blobs: [{ handle: 'log:old.wav', mime: 'audio/wav' }],
    }], blobs);
    const world = makeWatchWorld(join(scratch, 'data-w1'), makeWorkspace('bot-w1'), { autoTranscribe: true });
    installFetch(asrText('监听到的话。'));
    try {
      await world.start(host);
      host.add({ type: 'listen.chunk', source: 'listen', text: '', blobs: [{ handle: 'log:new.wav', mime: 'audio/wav' }] });
      await waitFor(() => host.events.length > 0);
      eq(host.events[0].type, 'stt.transcript', '事件类型');
      assert(host.events[0].text.includes('监听到的话。'), host.events[0].text);
      assert(host.events[0].text.includes('（监听 listen.chunk）'), '事件正文没标它是监听来的');
      eq(host.events[0].meta.source.ref, 'log:new.wav', '不该补转启动前的旧事件');
      eq(host.pushed[0].opts.deliver, true, '默认投递到对话');
      const list = await world.invoke('transcripts', 'list', [10]);
      eq(list.count, 1, '只该有一条记录');
      eq(list.items[0].note, '监听 listen.chunk', '记录名字');
    } finally {
      restoreFetch();
      await world.stop();
    }
  });

  await checkAsync('监听：按事件类型挑，archive 只落库，关着不转写', async () => {
    const body = wav.sampleWav(0.3);
    const blobs = { 'log:a.wav': { bytes: new Uint8Array(body), mime: 'audio/wav' } };
    let asked = 0;
    installFetch((u) => {
      asked += 1;
      return asrText('一句。')(u);
    });
    try {
      const host = makeHost([], blobs);
      const world = makeWatchWorld(join(scratch, 'data-w2'), makeWorkspace('bot-w2'), { autoTranscribe: true, eventDelivery: 'archive' });
      await world.start(host);
      host.add({ type: 'other.audio', source: 'other', text: '', blobs: [{ handle: 'log:a.wav', mime: 'audio/wav' }] });
      await new Promise((done) => setTimeout(done, 80));
      eq(asked, 0, '没监听的事件类型不该转');
      host.add({ type: 'listen.chunk', source: 'listen', text: '', blobs: [{ handle: 'log:a.wav', mime: 'audio/wav' }] });
      await waitFor(() => host.events.length > 0);
      eq(host.events[0].type, 'stt.transcript', '事件类型');
      eq(host.pushed[0].opts.deliver, false, 'archive 不该投递');
      await world.stop();

      const before = asked;
      const host2 = makeHost([], blobs);
      const world2 = makeWatchWorld(join(scratch, 'data-w3'), makeWorkspace('bot-w3'));
      await world2.start(host2);
      host2.add({ type: 'listen.chunk', source: 'listen', text: '', blobs: [{ handle: 'log:a.wav', mime: 'audio/wav' }] });
      await new Promise((done) => setTimeout(done, 80));
      eq(asked, before, '关着自动转写不该转');
      await world2.stop();
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('监听：坏句柄只跳过这一块，接口失败后 10 秒内不再重试', async () => {
    const body = wav.sampleWav(0.3);
    const blobs = { 'log:good.wav': { bytes: new Uint8Array(body), mime: 'audio/wav' } };
    const host = makeHost([], blobs);
    const world = makeWatchWorld(join(scratch, 'data-w4'), makeWorkspace('bot-w4'), { autoTranscribe: true });
    let asked = 0;
    installFetch(() => {
      asked += 1;
      return jsonRes({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, 401);
    });
    try {
      await world.start(host);
      host.add({ type: 'listen.chunk', source: 'listen', text: '', blobs: [{ handle: 'log:missing.wav', mime: 'audio/wav' }] });
      await new Promise((done) => setTimeout(done, 80));
      eq(asked, 0, '解析不出句柄不该联网');
      eq(host.events.length, 0, '坏句柄不该发事件');
      host.add({ type: 'listen.chunk', source: 'listen', text: '', blobs: [{ handle: 'log:good.wav', mime: 'audio/wav' }] });
      await waitFor(() => host.events.length > 0);
      eq(asked, 1, '接口只该被问一次');
      eq(host.events[0].type, 'stt.transcribe-failed', '事件类型');
      assert(host.events[0].text.includes('监听 listen.chunk'), host.events[0].text);
      host.add({ type: 'listen.chunk', source: 'listen', text: '', blobs: [{ handle: 'log:good.wav', mime: 'audio/wav' }] });
      await new Promise((done) => setTimeout(done, 80));
      eq(asked, 1, '失败冷却内不再重试');
    } finally {
      restoreFetch();
      await world.stop();
    }
  });

  // -------------------------------------------------------------------------
  console.log('WebUI bundle');

  check('纯 ESM：没有顶层 import', () => {
    const src = readFileSync(join(pkgDir, 'dist', 'webui.js'), 'utf8');
    assert(!/^\s*import\s/m.test(src), 'webui bundle 顶层不该有 import');
  });

  await checkAsync('panels 导出形状', async () => {
    const bundle = await import(pathToFileURL(join(pkgDir, 'dist', 'webui.js')).href);
    const panels = bundle.default?.panels ?? {};
    assert(typeof panels.transcripts?.mount === 'function', '缺 transcripts.mount');
    assert(typeof panels.status?.mount === 'function', '缺 status.mount');
  });
} catch (err) {
  bad(`未捕获的异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  restoreFetch();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 项通过，${warned} 个提醒，${failed} 个失败`);
process.exit(failed === 0 ? 0 : 1);
