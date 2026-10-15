#!/usr/bin/env node
/**
 * 联网真转写一条：拿部署里已配的密钥（只读 .env，不打印密钥），
 * 走完「音频文件 → 接口 → 文字 → 记录」整条路，记录存在临时目录里。
 *
 * 跑法：
 *   $env:LIVE_BOT_DIR = "D:\program\Coopanion\data\home\companion"   # 必填
 *   $env:LIVE_AUDIO = "D:\samples\hello.wav"                        # 必填：要转写的音频
 *   node tools/live.mjs
 * 可加 LIVE_PROTOCOL / LIVE_BASE_URL / LIVE_MODEL / LIVE_KEY_SECRET / LIVE_LANGUAGE / LIVE_CONTEXT。
 * 没有配好密钥、或不想花这份钱，就别跑。
 */
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const botDir = process.env.LIVE_BOT_DIR;
if (!botDir || !existsSync(botDir)) {
  console.error('先用 LIVE_BOT_DIR 指一个部署目录（里面有 .env），例如 D:\\program\\Coopanion\\data\\home\\companion');
  process.exit(2);
}

const audioPath = process.env.LIVE_AUDIO || '';
if (!audioPath || !existsSync(audioPath) || !statSync(audioPath).isFile()) {
  console.error('用 LIVE_AUDIO 指一个要转写的音频文件，例如 D:\\samples\\hello.wav');
  process.exit(2);
}

const protocol = process.env.LIVE_PROTOCOL === 'openai' ? 'openai' : 'dashscope';
const secretName = process.env.LIVE_KEY_SECRET || 'AUDIO_API_KEY';
let apiKey = '';
if (protocol === 'dashscope') {
  const env = readFileSync(join(botDir, '.env'), 'utf8');
  const hit = new RegExp(`^\\s*${secretName}\\s*=\\s*(\\S+)`, 'm').exec(env);
  if (!hit) {
    console.error(`部署 .env 里没有 ${secretName} 这一行`);
    process.exit(2);
  }
  apiKey = hit[1];
}

const api = await import(pathToFileURL(join(pkgDir, 'src', 'api.js')).href);
const { Transcripts } = await import(pathToFileURL(join(pkgDir, 'src', 'transcripts.js')).href);
const { formatKb, wavInfo } = await import(pathToFileURL(join(pkgDir, 'src', 'wav.js')).href);

const bytes = readFileSync(audioPath);
const ext = extname(audioPath).replace(/^\./, '').toLowerCase();
const mime = api.sniffAudio(bytes) ?? api.MIME_BY_EXT[ext] ?? '';
const info = wavInfo(bytes);
const fileName = audioPath.split(/[/\\]/).pop() || 'audio';

const opts = {
  baseUrl: process.env.LIVE_BASE_URL || 'https://dashscope.aliyuncs.com',
  apiKey,
  model: process.env.LIVE_MODEL || 'qwen-audio-3.1-asr-flash',
  bytes,
  mime,
  format: api.formatOf(audioPath, mime),
  sampleRate: info?.sampleRate ?? 0,
  languageHints: process.env.LIVE_LANGUAGE ? [process.env.LIVE_LANGUAGE] : [],
  context: process.env.LIVE_CONTEXT || '',
  name: fileName,
  timeoutMs: 180000,
};

console.log(`转写中：${opts.model} · ${opts.baseUrl}`);
console.log(`  音频：${audioPath}（${formatKb(bytes.length)}${info?.seconds ? ` · ${info.seconds.toFixed(1)} 秒` : ''} · ${mime || '(认不出 mime)'}）`);
if (protocol === 'dashscope' && !opts.format) {
  console.error('认不出这份音频的格式（dashscope 需要）：换成 wav / mp3 这类常见格式再试。');
  process.exit(2);
}
const started = Date.now();
const res = protocol === 'openai' ? await api.transcribeByOpenAi(opts) : await api.transcribeByDashScope(opts);

const dir = mkdtempSync(join(tmpdir(), 'stt-live-'));
const store = new Transcripts({ dir, keep: 0 });
store.add({
  text: res.text,
  note: '联网自检',
  source: { kind: 'live', ref: audioPath },
  model: opts.model,
  protocol: res.shape,
  language: res.language ?? '',
  seconds: res.seconds ?? info?.seconds ?? null,
  audioBytes: bytes.length,
  audioMime: mime,
  format: opts.format ?? '',
  usage: res.usage,
});

console.log('完成：');
console.log(`  文字：${res.text}`);
console.log(`  来源：${audioPath}`);
console.log(`  参数：${res.shape} · ${mime || '(认不出 mime)'}${opts.format ? ` / ${opts.format}` : ''}${res.language ? ` · 语言 ${res.language}` : ''} · 延迟：${Date.now() - started} ms`);
console.log(`  用量：${res.usage ? JSON.stringify(res.usage) : '(接口没给)'}`);
console.log(`  记录：${store.indexFile}`);
console.log(`  这个临时目录没被清掉，方便你自己翻一眼：${dir}`);
