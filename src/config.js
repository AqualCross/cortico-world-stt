/**
 * 语音转文本的配置段与文案。
 *
 * 段名是 `config.json` 的 `worlds.stt`。控制台热改就地写这个对象，
 * World 每次用时现读，所以这里只有默认值与 schema，不持有副本。
 */

export const ID = 'stt';
export const LABEL = '语音转文本';

/** `worlds.stt` 段的默认值；键名与 configGroup 里的路径一一对应。 */
export const DEFAULTS = Object.freeze({
  enabled: false,
  protocol: 'dashscope',
  baseUrl: 'https://dashscope.aliyuncs.com',
  apiKeySecret: 'AUDIO_API_KEY',
  model: 'qwen-audio-3.1-asr-flash',
  languageHints: '',
  context: '',
  keepDialect: false,
  itn: false,
  sampleRate: 0,
  maxMb: 7,
  timeoutMs: 120000,
  saveDir: '',
  keep: 200,
  pushToConsole: true,
});

/** 采样率可选项（Hz）；0 = 自动（wav 读文件头，其余不发）。 */
export const SAMPLE_RATES = Object.freeze([0, 8000, 12000, 16000, 22050, 24000, 44100, 48000]);

const ZH = {
  label: '语音转文本',
  lamp: '转写接口',
  badgeCount: '记录',
  badgeKey: '密钥',
  badgeModel: '模型',
  keySet: '已填',
  keyUnset: '未填',
  panelListTitle: '转写',
  panelListDesc: '转写过的记录；可复制文本、看来源。源音频不会被复制。',
  panelStatusTitle: '状态',
  panelStatusDesc: '接口、密钥与记录目录。',
  readyOk: (model) => `可用：${model}`,
  readyNoBase: '未配置接口地址',
  readyNoKey: '未填密钥',
  readyNoModel: '未选模型',
  config: {
    title: '语音转文本',
    enabled: '启用语音转文本',
    enabledDesc: '开启后桌宠才拿到 stt_transcribe 工具（把音频文件转成文字）。',
    protocol: '接口协议',
    protocolDesc: '接口形状。',
    baseUrl: '接口地址',
    baseUrlDesc: '接口的根地址。',
    keyName: '密钥变量名',
    keyNameDesc: '密钥在 .env 里的变量名；密钥本身在「状态」页填。',
    model: '模型',
    modelDesc: '模型名；qwen3-asr-* 与 qwen-audio-3.x-asr-* 请求体不同，插件按名字自动选。',
    langHint: '语言提示',
    langHintDesc: '可选：zh / en / ja 等，逗号分隔（dashscope 最多 4 个，openai 兼容只用第一个）；留空自动识别。',
    context: '语境提示',
    contextDesc: '可选词表提示：专有名词、术语要写音频里真会说的原词（上下文靠词表匹配生效，描述性文字帮助有限）；一段 400 字以内，重要的词放前面；留空不发。',
    keepDialect: '保留方言',
    keepDialectDesc: '仅 dashscope + qwen-audio-3.x：开启后方言按原样转写，关闭转为普通话文本。',
    itn: '口语数字规范化',
    itnDesc: '仅 dashscope + qwen3-asr-*：把「一千零二十」这类口语数字转成 1020、日期规范化（ITN）。',
    sampleRate: '采样率',
    sampleRateDesc: '0 = 自动（wav 读文件头）；仅 dashscope 且非 qwen3 模型会随请求发送。',
    maxMb: '文件上限',
    maxMbDesc: '单次识别的音频大小上限（MB）；base64 后体积约 ×1.4，dashscope 编码上限 10MB。',
    timeout: '超时',
    timeoutDesc: '单次转写的等待上限。',
    saveDir: '记录目录',
    saveDirDesc: '留空 = 插件数据目录下的 stt/。',
    keep: '保留条数',
    keepDesc: '超出后删最旧的记录（只删记录，不碰源文件）；0 = 不清理。',
    push: '推送到转写页',
    pushDesc: '转写后实时显示在「转写」页。',
  },
};

const EN = {
  label: 'Speech to Text',
  lamp: 'STT API',
  badgeCount: 'Transcripts',
  badgeKey: 'API key',
  badgeModel: 'Model',
  keySet: 'set',
  keyUnset: 'missing',
  panelListTitle: 'Transcripts',
  panelListDesc: 'Everything transcribed so far; copy the text or inspect the source. Source audio is never copied.',
  panelStatusTitle: 'Status',
  panelStatusDesc: 'Endpoint, key and transcript folder.',
  readyOk: (model) => `ready: ${model}`,
  readyNoBase: 'no endpoint configured',
  readyNoKey: 'no API key',
  readyNoModel: 'no model selected',
  config: {
    title: 'Speech to Text',
    enabled: 'Enable Speech to Text',
    enabledDesc: 'Turns on the stt_transcribe tool for the bot (audio file to text).',
    protocol: 'Protocol',
    protocolDesc: 'Request shape.',
    baseUrl: 'Endpoint',
    baseUrlDesc: 'Root URL of the API.',
    keyName: 'Secret name',
    keyNameDesc: 'Name of the secret in .env; the key itself goes on the Status panel.',
    model: 'Model',
    modelDesc: 'Model name; qwen3-asr-* and qwen-audio-3.x-asr-* use different request bodies and are picked by name.',
    langHint: 'Language hints',
    langHintDesc: 'Optional zh / en / ja codes, comma-separated (dashscope keeps up to 4; OpenAI compatible uses the first); empty auto-detects.',
    context: 'Context hint',
    contextDesc: 'Optional word list: write proper nouns / jargon exactly as they will be spoken (context works by word matching; descriptions alone help little). Up to 400 chars, most important words first; empty sends nothing.',
    keepDialect: 'Keep dialect',
    keepDialectDesc: 'dashscope + qwen-audio-3.x only: keep dialect expressions instead of normalizing to Mandarin.',
    itn: 'Inverse text normalization',
    itnDesc: 'dashscope + qwen3-asr-* only: turn spoken numbers and dates into digits (ITN).',
    sampleRate: 'Sample rate',
    sampleRateDesc: '0 = auto (read the WAV header); only sent by dashscope with non-qwen3 models.',
    maxMb: 'File size cap',
    maxMbDesc: 'Per-file audio size cap (MB); base64 grows it ~1.4x and dashscope encodes up to 10MB.',
    timeout: 'Timeout',
    timeoutDesc: 'How long one transcription may take.',
    saveDir: 'Transcript folder',
    saveDirDesc: 'Empty means the plugin data directory plus stt/.',
    keep: 'Keep',
    keepDesc: 'Oldest transcript records are pruned above this count (records only, never the source files); 0 disables pruning.',
    push: 'Push to Transcripts panel',
    pushDesc: 'Show new transcripts live on the Transcripts panel.',
  },
};

export function text(language = 'zh') {
  return language === 'en' ? EN : ZH;
}

/** 控制台的配置组；路径必须落在 `worlds.stt.` 段内，且每个键都在 DEFAULTS 里有对应项。 */
export function configGroup(language = 'zh') {
  const t = text(language).config;
  const K = `worlds.${ID}`;
  return {
    id: `world:${ID}`,
    owner: `world:${ID}`,
    schema: {
      type: 'object',
      title: t.title,
      properties: {
        [`${K}.enabled`]: { type: 'boolean', title: t.enabled, description: t.enabledDesc, 'x-hot': true },
        [`${K}.protocol`]: {
          type: 'string',
          title: t.protocol,
          description: t.protocolDesc,
          enum: ['dashscope', 'openai'],
          'x-hot': true,
        },
        [`${K}.baseUrl`]: { type: 'string', title: t.baseUrl, description: t.baseUrlDesc, 'x-hot': true },
        [`${K}.apiKeySecret`]: { type: 'string', title: t.keyName, description: t.keyNameDesc },
        [`${K}.model`]: { type: 'string', title: t.model, description: t.modelDesc, 'x-hot': true },
        [`${K}.languageHints`]: { type: 'string', title: t.langHint, description: t.langHintDesc, 'x-hot': true },
        [`${K}.context`]: { type: 'string', title: t.context, description: t.contextDesc, 'x-hot': true },
        [`${K}.keepDialect`]: { type: 'boolean', title: t.keepDialect, description: t.keepDialectDesc, 'x-hot': true },
        [`${K}.itn`]: { type: 'boolean', title: t.itn, description: t.itnDesc, 'x-hot': true },
        [`${K}.sampleRate`]: {
          type: 'integer',
          title: t.sampleRate,
          description: t.sampleRateDesc,
          enum: [...SAMPLE_RATES],
          'x-suffix': 'Hz',
          'x-hot': true,
        },
        [`${K}.maxMb`]: {
          type: 'integer',
          title: t.maxMb,
          description: t.maxMbDesc,
          minimum: 1,
          maximum: 9,
          'x-suffix': 'MB',
          'x-hot': true,
        },
        [`${K}.timeoutMs`]: {
          type: 'integer',
          title: t.timeout,
          description: t.timeoutDesc,
          minimum: 10000,
          maximum: 900000,
          multipleOf: 1000,
          'x-suffix': 'ms',
          'x-hot': true,
        },
        [`${K}.saveDir`]: {
          type: 'string',
          title: t.saveDir,
          description: t.saveDirDesc,
          'x-path': { kind: 'directory' },
          'x-hot': true,
        },
        [`${K}.keep`]: {
          type: 'integer',
          title: t.keep,
          description: t.keepDesc,
          minimum: 0,
          maximum: 5000,
          multipleOf: 10,
          'x-suffix': ' 条',
        },
        [`${K}.pushToConsole`]: { type: 'boolean', title: t.push, description: t.pushDesc, 'x-hot': true },
      },
    },
  };
}
