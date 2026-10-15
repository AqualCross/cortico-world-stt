#!/usr/bin/env node
/**
 * 离线检查：不联网、不碰安装目录。跑法：node tools/check.mjs
 *
 * 覆盖：清单与声明 / 工具声明 / 配置组路径 / 面板声明 / WAV 工具 /
 * 转写记录仓库（入库、索引、裁剪、坏索引容错）/ 接口客户端（打桩 fetch，两种
 * DashScope 请求体 + OpenAI 兼容 multipart）/ 工具整条链（打桩 fetch、打桩宿主）/
 * 控制台 bundle 的导出形状。
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
  const world = def.create({
    cfg,
    dataDir: opts.dataDir ?? join(scratch, 'data'),
    botDir: opts.botDir ?? join(scratch, 'bot'),
    packageDir: pkgDir,
    secret: () => (opts.key === undefined ? 'sk-test' : opts.key),
    storeSecret: (name, value) => stored.push([name, value]),
  });
  world.__stored = stored;
  return world;
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

  check('package.json 的 cortico 段与 consoleClient', () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    eq(manifest.name, 'cortico-world-stt', 'name');
    eq(manifest.cortico?.kind, 'world', 'kind');
    eq(manifest.cortico?.api, 5, 'api');
    eq(manifest.cortico?.displayName, '语音转文本', 'displayName');
    assert(typeof manifest.cortico?.consoleClient === 'string' && manifest.cortico.consoleClient, '缺 consoleClient');
    assert(existsSync(join(pkgDir, manifest.cortico.consoleClient)), 'consoleClient 文件不在包里');
    assert(Array.isArray(manifest.keywords) && manifest.keywords.includes('cortico-world'), 'keywords 缺 cortico-world');
  });

  check('默认导出是 WorldDefinition', () => {
    eq(def.id, 'stt', 'id');
    eq(def.label, '语音转文本', 'label');
    const defaults = def.defaults();
    eq(defaults.enabled, false, 'enabled 默认 false');
    eq(defaults.protocol, 'dashscope', 'protocol 默认');
    eq(defaults.model, 'qwen-audio-3.1-asr-flash', 'model 默认');
    eq(defaults.maxMb, 7, 'maxMb 默认');
    def.preflight(); // 环境满足时不抛
  });

  check('配置组与默认值一一对应，且都在 worlds.stt 段内', () => {
    const group = config.configGroup('zh');
    const paths = Object.keys(group.schema.properties);
    for (const path of paths) {
      assert(path.startsWith('worlds.stt.'), `配置路径不在 worlds.stt：${path}`);
      const short = path.slice('worlds.stt.'.length);
      assert(Object.hasOwn(config.DEFAULTS, short), `配置 ${short} 没有默认值`);
    }
    for (const short of Object.keys(config.DEFAULTS)) {
      assert(paths.includes(`worlds.stt.${short}`), `默认值 ${short} 没有进 schema`);
    }
  });

  check('不写系统提示词：没有环境段、没有提示词文档', () => {
    const world = makeWorld();
    eq(world.envPromptVars(), null, 'envPromptVars 应为 null');
    const decl = world.console('zh');
    assert(!decl.promptDocs || decl.promptDocs.length === 0, '不该再声明提示词文档');
    eq(decl.label, '语音转文本', 'label');
  });

  // -------------------------------------------------------------------------
  console.log('World 与工具');

  check('工具只有一个 stt_transcribe，声明齐全', () => {
    const world = makeWorld();
    const tools = world.tools();
    eq(tools.length, 1, '工具数量');
    const tool = tools[0];
    eq(tool.name, 'stt_transcribe', '工具名');
    assert(Array.isArray(tool.tags) && tool.tags.includes('read'), 'tags 该是 read');
    eq(tool.interruptible, true, 'interruptible');
    eq(tool.parameters.required?.[0], 'audio', 'required[0]');
    assert(tool.parameters.properties?.audio, '缺 audio 参数');
    assert(tool.parameters.properties?.note, '缺 note 参数');
    assert(tool.parameters.properties?.language, '缺 language 参数');
    assert(tool.parameters.properties?.context, '缺 context 参数');
  });

  check('面板与配置组声明', () => {
    const world = makeWorld();
    const decl = world.console('zh');
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

  // -------------------------------------------------------------------------
  console.log('工具整条链');

  await checkAsync('转写 → 记录 → 回执（文件路径输入）', async () => {
    const body = wav.sampleWav(0.4);
    const botDir = makeWorkspace('bot-a', 'hello.wav', body);
    const world = makeWorld({}, { dataDir: join(scratch, 'data-a'), botDir });
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
    const world = makeWorld({}, { dataDir: join(scratch, 'data-b') });
    const host = {
      blob: (h) => (h === 'mem:ok.wav' ? { bytes: new Uint8Array(body), mime: 'audio/wav' } : null),
      log: {},
    };
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
  console.log('控制台 bundle');

  check('纯 ESM：没有顶层 import', () => {
    const src = readFileSync(join(pkgDir, 'dist', 'console.js'), 'utf8');
    assert(!/^\s*import\s/m.test(src), 'console bundle 顶层不该有 import');
  });

  await checkAsync('panels 导出形状', async () => {
    const bundle = await import(pathToFileURL(join(pkgDir, 'dist', 'console.js')).href);
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
