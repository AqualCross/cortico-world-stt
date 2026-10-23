/**
 * WorldDefinition：装配层在构造所有可用定义时也会跑 create()，
 * 所以构造函数必须是纯的（不建目录、不发请求、不读密钥也行）。
 */
import { DEFAULTS, ID, LABEL } from './config.js';
import { STT_TOOL_DECLS, SttWorld } from './world.js';

/** 自描述里每个工具配一句给人看的话，按工具名。 */
const TOOL_SUMMARIES = {
  stt_transcribe: {
    zh: '把一个音频文件（或 log:/mem: 句柄）转写成文字，记进转写记录并交回对话；event 交付时立刻回执，结果稍后以事件送达。',
    en: 'Transcribe an audio file (or a log:/mem: handle) to text; the text is saved to the transcript list and returned to the conversation. With event delivery the call returns at once and the text arrives later as an event.',
  },
  stt_watch: {
    zh: '打开或关闭「自动转写事件音频」，更换监听的事件类型或转写事件的去处，或查看当前状态。',
    en: 'Turn automatic transcription of event audio on or off, change the watched event types or where transcript events go, or read the current state.',
  },
};

/** 与框架 `describeTools()` 相同的拼法：取发给模型的字段，再加一句 summary。 */
function describeTools(decls) {
  return decls.map(({ name, description, parameters, tags }) => ({
    name,
    description,
    parameters,
    tags,
    summary: TOOL_SUMMARIES[name],
  }));
}

export const sttDefinition = {
  id: ID,
  label: LABEL,
  /** `worlds.stt` 段的默认值；启用与否由部署决定，定义里恒为 false。 */
  defaults: () => structuredClone(DEFAULTS),
  preflight: () => {
    if (typeof fetch !== 'function' || typeof AbortSignal?.timeout !== 'function') {
      throw new Error('语音转文本需要 Node 22+ 的全局 fetch / AbortSignal.timeout');
    }
  },
  create: (ctx) => new SttWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir,
    botDir: ctx.botDir,
    secret: (name) => ctx.secret(name),
    storeSecret: (name, value) => ctx.storeSecret(name, value),
    persist: typeof ctx.persist === 'function' ? (patch) => ctx.persist(patch) : undefined,
  }),
  /** 自描述：可能出现的全部工具与事件，不进提示词。`describe:extension` 把它导出成 describe.json。 */
  describe: {
    tools: describeTools(STT_TOOL_DECLS),
    events: [
      {
        type: 'stt.transcript',
        description: {
          zh: '转写完成：正文是转写文字，meta 带任务号、模型与来源；去处由 worlds.stt.eventDelivery 决定（监听到的音频也走这里）。',
          en: 'Transcription finished: the text is the transcript; meta carries the task id, model and source. Where it goes is set by worlds.stt.eventDelivery (watched audio lands the same way).',
        },
        trigger: 'debounce',
      },
      {
        type: 'stt.transcribe-failed',
        description: {
          zh: '转写失败或超时：正文是原因，meta 带任务号与来源。',
          en: 'Transcription failed or timed out: the text is the reason; meta carries the task id and source.',
        },
        trigger: 'debounce',
      },
    ],
  },
};

export default sttDefinition;
