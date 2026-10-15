/**
 * 语音转文本（ASR）HTTP 接口的最小客户端，只用 Node 22 自带的 fetch。
 *
 * 两种形状：
 *
 * 1. `dashscope` —— 阿里云百炼的同步转写接口：
 *      POST <baseUrl>/api/v1/services/aigc/multimodal-generation/generation
 *    同一端点下，两族模型的请求体不同，按模型名分派：
 *      - `qwen3-asr-*`：content 里直接放 `{audio: dataURI}`，参数走 `parameters.asr_options`；
 *      - `qwen-audio-3.x-asr-*` / `fun-asr-*`：content 里放
 *        `{type:'input_audio', input_audio:{data: dataURI}}`，参数走
 *        `parameters.format / sample_rate / language_hints / keep_dialect`。
 *    本地音频一律编码成 `data:<mime>;base64,<data>`（编码上限 10MB）。
 *
 * 2. `openai` —— OpenAI 兼容的 `/v1/audio/transcriptions`（whisper.cpp、faster-whisper
 *    这类本地服务），multipart 上传，响应里取 `text`。
 */

/** 请求失败；`status` 是 HTTP 状态码，0 表示没走到服务端。 */
export class SttApiError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'SttApiError';
    this.status = Number(opts.status) || 0;
    this.code = String(opts.code ?? '');
    this.body = String(opts.body ?? '');
  }
}

const DEFAULT_TIMEOUT = 120000;

/** 百炼同步转写路径；baseUrl 是根地址，不含它。 */
export const DASHSCOPE_ASR_PATH = 'api/v1/services/aigc/multimodal-generation/generation';

/** 扩展名 ↔ MIME。dashscope 的 data URI 与 openai 的 multipart 都用得上。 */
export const MIME_BY_EXT = Object.freeze({
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  mpeg: 'audio/mpeg',
  mpg: 'audio/mpeg',
  webm: 'video/webm',
  wma: 'audio/x-ms-wma',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  mkv: 'video/x-matroska',
  wmv: 'video/x-ms-wmv',
});

/** MIME → dashscope 的 `parameters.format` 取值。 */
const FORMAT_BY_MIME = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aiff': 'aiff',
  'video/webm': 'webm',
  'audio/webm': 'webm',
  'audio/x-ms-wma': 'wma',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/x-matroska': 'mkv',
  'video/x-ms-wmv': 'wmv',
};

function joinUrl(baseUrl, path) {
  const base = String(baseUrl ?? '').trim().replace(/[/\s]+$/, '');
  if (!base) throw new SttApiError('没有配置接口地址');
  return `${base}/${String(path).replace(/^\/+/, '')}`;
}

function snippet(value, max = 300) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 超时与调用方的 AbortSignal 合成一个信号。 */
function signalFor(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function describeNetworkError(err, timeoutMs) {
  if (err?.name === 'TimeoutError') return `等 ${Math.round(timeoutMs / 1000)} 秒没有响应，超时了`;
  if (err?.name === 'AbortError') return '调用被中断了';
  const detail = err?.cause?.message ?? err?.message ?? err;
  return `连不上转写接口：${snippet(detail, 200)}`;
}

async function fetchTimed(url, init, timeoutMs, signal) {
  try {
    return await fetch(url, { ...init, signal: signalFor(timeoutMs, signal) });
  } catch (err) {
    throw new SttApiError(describeNetworkError(err, timeoutMs));
  }
}

/** 常见的失败提示；认不出就不加。 */
function hintsFor(status, code, raw) {
  const s = String(raw ?? '');
  if (status === 401 || status === 403) return '（密钥不对、没权限，或者这个模型没有开通）';
  if (status === 404) return '（接口地址或模型名不对）';
  if (status === 429) return '（触发限流，等一会儿再试）';
  if (status === 400 && /format|audio|decode|duration|size/i.test(s)) {
    return '（音频格式或大小不对：试试 wav / mp3，并确认文件能被正常播放）';
  }
  if (status === 400 && /model/i.test(s)) return '（模型名不对，或者这个模型没开通）';
  return '';
}

/** 异步 POST 一次并解析 JSON；非 2xx 抛 SttApiError，正文带给调用方。 */
async function postJson(url, { apiKey, body, timeoutMs, signal }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchTimed(url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs, signal);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const code = json?.code ?? json?.error?.code ?? '';
    const raw = json?.message ?? json?.error?.message ?? json?.msg ?? text;
    throw new SttApiError(
      `接口返回 ${res.status}${code ? ` [${code}]` : ''}：${snippet(raw, 300)}${hintsFor(res.status, code, raw)}`,
      { status: res.status, code, body: snippet(text, 800) },
    );
  }
  if (!json) throw new SttApiError(`接口没有返回 JSON：${snippet(text, 300)}`, { status: res.status });
  return json;
}

/** 从魔术字节认音频格式；认不出来给 null，别硬猜。 */
export function sniffAudio(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (b.length >= 5 && b.toString('ascii', 0, 5) === '#!AMR') return 'audio/amr';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'FORM' && b.toString('ascii', 8, 12) === 'AIFF') return 'audio/aiff';
  return null;
}

/** 从扩展名/MIME 推 dashscope 的 `format` 取值；推不出给 null。 */
export function formatOf(name, mime) {
  const byMime = FORMAT_BY_MIME[String(mime ?? '').trim().toLowerCase()];
  if (byMime) return byMime;
  const full = String(name ?? '').trim().toLowerCase();
  const ext = full.includes('.') ? full.split('.').pop() : '';
  if (ext && Object.hasOwn(MIME_BY_EXT, ext)) return ext === 'mpg' ? 'mpeg' : ext;
  return null;
}

/** 本地字节 → `data:<mime>;base64,<data>`。 */
export function dataUriOf(bytes, mime) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  return `data:${mime || 'audio/wav'};base64,${b.toString('base64')}`;
}

/** `qwen3-asr-*` 用另一套请求体（content.audio + asr_options）。 */
function isQwen3(model) {
  return /^qwen3-asr/i.test(String(model ?? '').trim());
}

/** 把 content 字段（字符串 / 数组 / 对象）收敛成一段文本。 */
function contentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((it) => (typeof it === 'string' ? it : String(it?.text ?? '')))
      .join('');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 百炼同步转写一次。
 *
 * @param {object} opts baseUrl / apiKey / model / bytes / mime / format / sampleRate /
 *   languageHints / context / keepDialect / itn / timeoutMs / signal
 * @returns {Promise<{text: string, language: string|null, seconds: number|null,
 *   usage: object|null, requestId: string, shape: 'qwen3'|'qwen-audio'}>}
 */
export async function transcribeByDashScope(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT;
  const model = String(opts.model ?? '').trim();
  const mime = String(opts.mime ?? '').trim() || 'audio/wav';
  const bytes = Buffer.isBuffer(opts.bytes) ? opts.bytes : Buffer.from(opts.bytes ?? []);
  if (!bytes.length) throw new SttApiError('音频是空的，没什么可转写的');

  const hints = Array.isArray(opts.languageHints)
    ? opts.languageHints.map((s) => String(s ?? '').trim()).filter(Boolean)
    : [];
  const context = String(opts.context ?? '').trim();
  const data = dataUriOf(bytes, mime);
  const qwen3 = isQwen3(model);

  const messages = [];
  let parameters = {};
  if (qwen3) {
    // qwen3 不支持采样率与 format 参数，语言走 asr_options。
    messages.push({ role: 'user', content: [{ audio: data }] });
    const asrOptions = {};
    if (hints.length) asrOptions.language = hints[0];
    if (opts.itn === true) asrOptions.enable_itn = true;
    if (Object.keys(asrOptions).length) parameters.asr_options = asrOptions;
  } else {
    const format = String(opts.format ?? '').trim();
    if (!format) throw new SttApiError('认不出音频格式：把文件换成 wav / mp3 这类常见格式，或补一个正确的扩展名');
    if (context) {
      // 上下文消息在前，待识别的音频必须放最后一条。
      messages.push({ role: 'user', content: [{ type: 'input_text', text: context }] });
    }
    messages.push({ role: 'user', content: [{ type: 'input_audio', input_audio: { data } }] });
    parameters = { format };
    const sampleRate = positiveNumber(opts.sampleRate);
    if (sampleRate) parameters.sample_rate = String(Math.round(sampleRate));
    if (hints.length) parameters.language_hints = hints.slice(0, 4);
    if (opts.keepDialect === true) parameters.keep_dialect = true;
  }

  const json = await postJson(joinUrl(opts.baseUrl, DASHSCOPE_ASR_PATH), {
    apiKey: opts.apiKey,
    body: { model, input: { messages }, parameters },
    timeoutMs,
    signal: opts.signal,
  });

  const output = json?.output;
  let text = null;
  let language = null;
  if (qwen3) {
    const message = output?.choices?.[0]?.message;
    text = contentToString(message?.content);
    const annotations = Array.isArray(message?.annotations) ? message.annotations : [];
    const lang = annotations.find((it) => it && typeof it === 'object' && typeof it.language === 'string');
    if (lang) language = lang.language;
  } else {
    if (typeof output?.text === 'string') text = output.text;
    else if (Array.isArray(output?.sentences)) text = output.sentences.map((s) => String(s?.text ?? '')).join('');
    else if (typeof output?.sentence?.text === 'string') text = output.sentence.text;
  }
  if (text === null) {
    throw new SttApiError(`接口没给识别结果：${snippet(JSON.stringify(json ?? {}), 300)}`);
  }

  const usage = json?.usage && typeof json.usage === 'object' ? json.usage : null;
  const seconds = positiveNumber(usage?.duration ?? usage?.seconds ?? usage?.prompt_tokens_details?.seconds);
  return {
    text,
    language,
    seconds,
    usage,
    requestId: typeof json?.request_id === 'string' ? json.request_id : '',
    shape: qwen3 ? 'qwen3' : 'qwen-audio',
  };
}

// ---------------------------------------------------------------------------
// OpenAI 兼容形态（/v1/audio/transcriptions，whisper.cpp 这类本地服务）
// ---------------------------------------------------------------------------

/** OpenAI 兼容转写的地址：根地址或 /v1 结尾都收。 */
export function openAiTranscriptionUrl(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/[/\s]+$/, '');
  if (!base) throw new SttApiError('没有配置接口地址');
  return /\/v1$/i.test(base) ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
}

/**
 * OpenAI 兼容形态：POST `<base>/v1/audio/transcriptions`，multipart 上传音频，
 * 响应 JSON 里取 `text`（部分服务只给纯文本，也认）。
 *
 * @param {object} opts baseUrl / apiKey / model / bytes / mime / name /
 *   languageHints / context / timeoutMs / signal
 * @returns {Promise<{text: string, language: string|null, seconds: number|null,
 *   usage: null, requestId: string, shape: 'openai'}>}
 */
export async function transcribeByOpenAi(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT;
  const bytes = Buffer.isBuffer(opts.bytes) ? opts.bytes : Buffer.from(opts.bytes ?? []);
  if (!bytes.length) throw new SttApiError('音频是空的，没什么可转写的');
  const model = String(opts.model ?? '').trim() || 'whisper-1';
  const mime = String(opts.mime ?? '').trim() || 'audio/wav';
  const name = String(opts.name ?? '').trim() || 'audio.wav';
  const hints = Array.isArray(opts.languageHints)
    ? opts.languageHints.map((s) => String(s ?? '').trim()).filter(Boolean)
    : [];
  const context = String(opts.context ?? '').trim();

  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'json');
  form.append('file', new Blob([bytes], { type: mime }), name);
  if (hints.length) form.append('language', hints[0]);
  if (context) form.append('prompt', context);

  const headers = {};
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await fetchTimed(openAiTranscriptionUrl(opts.baseUrl), {
    method: 'POST',
    headers,
    body: form,
  }, timeoutMs, opts.signal);

  const raw = await res.text();
  if (!res.ok) {
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    const detail = json?.detail ?? json?.error?.message ?? json?.message ?? raw;
    throw new SttApiError(
      `接口返回 ${res.status}：${snippet(detail, 300)}${hintsFor(res.status, '', detail)}`,
      { status: res.status, body: snippet(raw, 800) },
    );
  }

  const header = String(res.headers.get('content-type') ?? '').toLowerCase();
  let json = null;
  if (header.includes('json') || raw.trim().startsWith('{')) {
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
  }
  const text = json ? (typeof json.text === 'string' ? json.text : contentToString(json.text)) : raw.trim();
  if (text === null || text === undefined) {
    throw new SttApiError(`接口没给识别结果：${snippet(raw, 300)}`);
  }
  return {
    text: String(text),
    language: typeof json?.language === 'string' ? json.language : null,
    seconds: positiveNumber(json?.duration),
    usage: null,
    requestId: '',
    shape: 'openai',
  };
}
