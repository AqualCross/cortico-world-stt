/**
 * WorldDefinition：装配层在构造所有可用定义时也会跑 create()，
 * 所以构造函数必须是纯的（不建目录、不发请求、不读密钥也行）。
 */
import { DEFAULTS, ID, LABEL } from './config.js';
import { STT_TOOL_DECLS, SttWorld } from './world.js';

/** 自描述里每个工具配一句给人看的话，按工具名。 */
const TOOL_SUMMARIES = {
  stt_transcribe: {
    zh: '把一个音频文件（或 log:/mem: 句柄）转写成文字，记进转写记录并交回对话。',
    en: 'Transcribe an audio file (or a log:/mem: handle) to text; the text is saved to the transcript list and returned to the conversation.',
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
  }),
  /** 自描述：可能出现的全部工具与事件，不进提示词。`describe:extension` 把它导出成 describe.json。 */
  describe: {
    tools: describeTools(STT_TOOL_DECLS),
    events: [],
  },
};

export default sttDefinition;
