# 语音转文本 · cortico-world-stt

给 Coopanion 桌宠加一件事：**把音频文件转写成文字**。支持两种接口形状（阿里云百炼 Qwen-ASR 同步转写，与 OpenAI 兼容的 `/v1/audio/transcriptions`，后者可以接本地 whisper 服务），文字记进可浏览的转写记录，全文随工具回执交回对话。

这是一个 `cortico` 的 **World 扩展**（`kind: world`，`api: 5`），只补一个 `stt` 世界，
不依赖任何第三方 npm 包（纯 ESM JS + Node 内置模块）。

> **它不采集声音、不做实时监听、不做语音切分、不做流式。** 没有麦克风，没有常驻进程：
> 它就是 agent 工具箱里的一件小事——递进来一个音频文件（或 `log:` / `mem:` 句柄），拿回一段文字。
> 「听」和「说」是别的工具的事（渠道世界转来语音条、TTS 世界负责出声）。
> 名字叫「语音转文本」而不是「实时语音识别」，就是在强调这一点。
>
> MIT 许可，见 [LICENSE](LICENSE)。非官方扩展：与 Coopanion / cortico 的作者无关。

## 它做了什么

装好并启用之后，桌宠会多出一个工具：

| 工具 | 标签 | 作用 |
| --- | --- | --- |
| `stt_transcribe` | `read` | 把一段音频（本地文件，或 `log:` / `mem:` 句柄）转写成文字，记进转写列表，并把全文放回回执 |

音频有两条来路：

1. **文件路径**：绝对路径，或相对路径（先按 `<bot 目录>/workspace/` 找，再按 `<bot 目录>` 找）。
2. **句柄**：`log:` 是对话里的音频附件（渠道世界里收到的语音条、别的工具发来的音频），`mem:` 是工作区里的文件。

文字有三条去向：

1. **交回对话**：工具回执里带全文（超过 6000 字符会截断并注明「全文在记录里」），模型拿到就能总结、翻译、回复、存档。
2. **记进「转写」页**：正文、来源、模型、语言、时长、大小、用量、时间——控制台里随时翻、随时复制。
3. **接着用**：模型收到的是普通文本，想干嘛干嘛——它只是一次工具调用的返回值。

**源音频不会被复制。** 记录里只留来源路径/句柄与元数据（大小、时长），源文件删了，转写记录照在。

## 安装

包目录就是你现在看的这个目录。三种装法，选一种：

**A. 控制台里装（推荐）**

设置 → 扩展 → 安装本地扩展，把本目录选给它。

**B. 命令行装**

在 `data/extensions` 目录里（`extensions/package.json` 所在处）执行：

```powershell
pnpm add "D:\path\to\cortico-world-stt" --ignore-workspace
```

它会往 `extensions/package.json` 的 `dependencies` 里写一条 `link:` 路径并连到 `node_modules/`。

**C. 手工连**

把 `data/extensions/node_modules/cortico-world-stt` 做成指向本目录的目录联接，
并自己在 `extensions/package.json` 里加 `"cortico-world-stt": "link:D:\\path\\to\\cortico-world-stt"`。

**装完必须重启 Coopanion**：扩展是 ESM 模块，进程内不会重新加载。重启后在
`config.json` 的 `worlds.stt.enabled` 上打开（控制台里也有这个开关），`stt_transcribe` 才会挂给桌宠。

### 一份能用的 `worlds.stt` 长什么样

`<安装目录>\data\home\<bot 目录>\config.json` 里，最小可用的一段：

```json
{
  "worlds": {
    "stt": {
      "enabled": true,
      "baseUrl": "https://dashscope.aliyuncs.com",
      "model": "qwen-audio-3.1-asr-flash",
      "apiKeySecret": "AUDIO_API_KEY"
    }
  }
}
```

密钥本体不写在这里（见下面「密钥」一节）。改之前建议先备份
`config.json`（例如存成 `config.json.bak-stt-<时间戳>`）。

**改完必须重启 Coopanion**：扩展是 ESM 模块，进程内不会重新加载。重启后控制台
左栏会多出「语音转文本」，「转写」页看转写过的记录、「状态」页改配置与密钥。

## 配置

都在 `worlds.stt` 段，控制台「语音转文本 → 状态」里改了就地生效，不用重启：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否把 `stt_transcribe` 挂给桌宠 |
| `protocol` | `dashscope` | `dashscope` = 百炼 Qwen-ASR 同步转写；`openai` = OpenAI 兼容的 `/v1/audio/transcriptions`（本地 whisper.cpp 这类） |
| `baseUrl` | `https://dashscope.aliyuncs.com` | 接口根地址；百炼的路径是 `/api/v1/services/aigc/multimodal-generation/generation` |
| `apiKeySecret` | `AUDIO_API_KEY` | 密钥的**变量名**：先看部署 `.env`，再退到 `<bot 目录>/../providers/<端点>/.env` |
| `model` | `qwen-audio-3.1-asr-flash` | 模型名；`qwen3-asr-*` 与 `qwen-audio-3.x-asr-*` / `fun-asr-*` 请求体不同，插件按名字自动选 |
| `languageHints` | 空 | 可选语言提示：`zh` / `en` / `ja` 等（多个用逗号分隔；dashscope 最多 4 个，qwen3 只取第一个，openai 兼容只发第一个）；留空自动识别 |
| `context` | 空 | 可选词表提示：专有名词、术语的**原词**（上下文靠词表匹配生效，写音频里真会说的词，描述性文字帮助有限；≤400 字，重要词放前）；qwen-audio-3.x 与 openai 会发，qwen3 暂不发 |
| `keepDialect` | `false` | 仅 `dashscope` + `qwen-audio-3.x`：开启后方言按原样转写，关闭转为普通话文本 |
| `itn` | `false` | 仅 `dashscope` + `qwen3-asr-*`：把「一千零二十」这类口语数字转成 1020、日期规范化（ITN） |
| `sampleRate` | `0` | 0 = 自动（wav 读文件头）；仅 dashscope 且非 qwen3 会随请求发送 |
| `maxMb` | `7` | 单次识别的音频大小上限（MB）；base64 后体积约 ×1.4，百炼编码上限 10MB |
| `timeoutMs` | `120000` | 单次转写（上传 + 识别）的等待上限 |
| `saveDir` | 空 | 留空 = 本插件数据目录下的 `stt/` |
| `keep` | `200` | 超出后自动删最旧的记录（只删记录，不碰源文件），`0` = 不清理 |
| `pushToConsole` | `true` | 转写完实时推给「转写」页 |

### context 怎么写才有效

官方文档两句话最要紧：**上下文靠词表匹配生效**——`text` 里要有音频里真会说的原词，光写「这是一段关于什么的描述」帮助有限；**一段最长 400 字**，超出从末尾截断（不报错）。所以：

- 专有名词按原样列：人名、昵称、术语、产品名、群名，例如 `本鲸（桌宠自称）、大肥鱼（主人）`；
- 词表、自然语言段落、两者混搭都行，对无关文字的容错很高；
- 重要的词放前面，整段控制在 400 字内；
- 配合 `languageHints` 声明单语种还能再提一档准确率（`zh` / `ja` 等）；
- 临时场景（这轮在聊某游戏、某位群友）让模型调用时用工具的 `context` 参数，会覆盖这里的默认值。

（实测：同一段音频不带 context 听成「本京」，带上含「本鲸」的 context 后正确转成「本鲸」。）

### 密钥

密钥**不写进 `config.json`**。两种填法：

- 控制台 →「语音转文本 → 状态」→ 把 key 粘进输入框 → 保存。它会写进 `<bot 目录>/.env` 的
  `AUDIO_API_KEY=...`，并立刻在这次进程里生效。
- 自己在那份 `.env` 里写一行 `AUDIO_API_KEY=sk-...`，然后重启。

`apiKeySecret` 改名成别的变量名也行，`.env` 里跟着改。
找不到部署 `.env` 里的那一行时，插件会去 `<bot 目录>/../providers/<端点>/.env`
里挨个找同名变量，找到就用（「状态」页会写密钥来源是哪一份）。

`protocol: "openai"` 的本地服务通常不需要密钥；没有时就不用填，状态页显示「未填」也不挡转写。

## 接口（阿里云百炼 Qwen-ASR）

- **端点**：`POST <baseUrl>/api/v1/services/aigc/multimodal-generation/generation`，
  `Authorization: Bearer <key>`，`Content-Type: application/json`。
- **按模型名分派两种请求体**（同一端点）：

  `qwen-audio-3.x-asr-*` / `fun-asr-*`（音频走 `input_audio`，上下文在前、音频在后）：

  ```json
  {
    "model": "qwen-audio-3.1-asr-flash",
    "input": {
      "messages": [
        { "role": "user", "content": [{ "type": "input_text", "text": "专有名词：本鲸。" }] },
        { "role": "user", "content": [{ "type": "input_audio", "input_audio": { "data": "data:audio/wav;base64,..." } }] }
      ]
    },
    "parameters": {
      "format": "wav",
      "sample_rate": "24000",
      "language_hints": ["zh"],
      "keep_dialect": false
    }
  }
  ```

  `qwen3-asr-*`（音频走 `content.audio`，参数走 `asr_options`）：

  ```json
  {
    "model": "qwen3-asr-flash",
    "input": { "messages": [{ "role": "user", "content": [{ "audio": "data:audio/wav;base64,..." }] }] },
    "parameters": { "asr_options": { "language": "zh", "enable_itn": true } }
  }
  ```

- **响应**：qwen-audio 族取 `output.text`（也认 `output.sentence` / `output.sentences`）；
  qwen3 族取 `output.choices[0].message.content`，语言标注在 `annotations` 里。
- **音频规格**：单段 ≤ 5 分钟；base64 编码后整包 ≤ 10MB；支持
  `aac / amr / avi / flac / flv / m4a / mkv / mov / mp3 / mp4 / mpeg / ogg / opus / wav / webm / wma / wmv`。
  默认 `maxMb 7`：base64 后约 9.8MB，正好压在 10MB 线内。
- **常见错误**：
  - `401 / 403`：密钥不对、没权限，或模型没开通；
  - `404`：接口地址或模型名不对；
  - `429`：限流；
  - `400 InvalidParameter` + 音频字样：格式或大小不对（换成 wav / mp3 再试）；
  - 「接口没给识别结果」：返回 200 但结构里没有文字——多半是模型名与请求体不匹配，换回默认模型对照。
- **计费**：按音频 token/秒；响应的 `usage`（含 `duration`）会存进记录里。

## 本地 STT：OpenAI 兼容接口（`protocol: "openai"`）

把 `protocol` 填 `openai`，扩展改走 OpenAI 兼容的 `POST <baseUrl>/v1/audio/transcriptions`：
`baseUrl` 填根地址即可（`http://127.0.0.1:8080` 或 `http://127.0.0.1:8080/v1` 都认），
multipart 上传：字段是 `model` / `response_format=json` / `file`，外加 `language`（语言提示的第一个）
与 `prompt`（语境提示）。响应收 JSON 里的 `text`，也收纯文本正文。本地服务通常不需要 key。

以 whisper.cpp 的服务器为例：

```powershell
whisper-server --model ggml-large-v3-turbo.bin --port 8080   # 新版；旧版可执行名是 server
```

```json
{
  "worlds": {
    "stt": {
      "enabled": true,
      "protocol": "openai",
      "baseUrl": "http://127.0.0.1:8080",
      "model": "whisper-1"
    }
  }
}
```

- 不填 `model` 时按 `whisper-1` 发；本地服务一般不看这个字段，照它的默认模型跑。
- `format` / `sampleRate` / `keepDialect` / `itn` 不适用于这套接口（不会发送）；
- 没开服务或端口不对时，回执会写「连不上转写接口」。

## 控制台页

- **转写**：转写过的记录（正文、来源、模型、语言、时长、源文件大小、时间），复制文字、
  复制来源、删除、清空；「插入自检记录」——离线造一条记录，走完
  「入库 → 索引 → 页面」，看不到它说明是扩展或面板的问题，不是接口的问题。
  页面开着时新转写会实时冒出来（关掉 `pushToConsole` 就 30 秒轮询追平）。
- **状态**：密钥填写/清除、试转写（系统文件选择器选一个音频文件，用当前配置真转写一次并记入列表）、
  协议/地址/模型/语言提示/语境/开关/采样率/上限/目录/索引/保留条数/密钥来源/最近错误/运行时。

## 自检

离线检查（不联网、不碰安装目录）：

```powershell
node tools/check.mjs
```

用**这套安装里的框架判据**真跑一遍装配检查（manifest 解析、dry-mount、工具名冲突、配置路径）：

```powershell
$env:COOPANION_APP_ROOT = "D:\program\Coopanion\resources\app"
node --experimental-transform-types tools/drymount.mts
```

联网真转写一条（要部署里已配密钥，会花一点钱）：

```powershell
$env:LIVE_BOT_DIR = "D:\program\Coopanion\data\home\companion"
$env:LIVE_AUDIO = "D:\samples\hello.wav"
node tools/live.mjs        # 可加 LIVE_PROTOCOL / LIVE_BASE_URL / LIVE_MODEL / LIVE_LANGUAGE / LIVE_CONTEXT
```

## 目录结构

```
cortico-world-stt/
├─ package.json        # cortico: { kind: world, api: 5, displayName: 语音转文本, consoleClient: dist/console.js }
├─ README.md
├─ src/
│  ├─ index.js         # 入口：default 导出 WorldDefinition
│  ├─ definition.js    # id/label/defaults/preflight/create
│  ├─ config.js        # worlds.stt 默认值、中英文案、配置组 schema
│  ├─ world.js         # SttWorld：工具、控制台面板、流式推送、生命周期
│  ├─ api.js           # 两种接口形状的 HTTP 客户端：请求体、错误归一化、mime 嗅探
│  ├─ transcripts.js   # 转写仓库：目录 + index.json（只存文本与元数据）
│  └─ wav.js           # WAV 时长/采样率解析、KB/时长文案、离线样本
├─ dist/console.js     # 浏览器侧面板 bundle（export default { panels }）
└─ tools/
   ├─ check.mjs        # 离线检查
   ├─ drymount.mts     # 用框架自带判据跑 dry-mount
   └─ live.mjs         # 联网真转写一条
```

## 启用之后

- 跟桌宠提一句你现在有 `stt_transcribe` 了：`{"audio": "workspace 里的文件.wav"}` 或
  `{"audio": "log:xxxx.wav"}`（对话里收到的音频附件）都能转。
- 想让它「听懂」QQ 语音条：渠道世界转来的语音在对话里以附件（`log:` 句柄）出现，
  让它把这个句柄交给 `stt_transcribe` 就行。
- 专有名词老识别错时，把词表填进 `context`（例如「本鲸、Coopanion、阿里云」），qwen-audio 族会带上下文。

## 已知限制

- **不采集、不监听、不流式**：没有麦克风、没有实时接口，一次只处理一个完整文件；
  「现在屋里有什么声音」这类要求不成立——得先有音频文件或附件。
- **不复制源音频**：记录里只有来源与元数据；源文件删了，文字仍在，但没法再「重听」。
- 回执只带文字，不产 blob；播放、发送都是别的工具的事。
- 单段音频 ≤ 5 分钟、编码后 ≤ 10MB 是接口限制；回执文字超 6000 字符截断，记录里也最多存 20000 字符。
- 参数不跨模型族：`keepDialect` 仅 `qwen-audio-3.x`；`itn` 仅 `qwen3-asr-*`；`sampleRate` 仅非 qwen3；
  换 `model` 时留意「状态」页里的说明。
- `protocol: "openai"` 下 `languageHints` 只发第一个、`context` 映射成 `prompt`；返回结构因服务而异（JSON / 纯文本都认）。

## 致谢

目录结构、扩展骨架与部分实现（记录仓库、dry-mount 检查等）改编自
[cortico-world-image](https://github.com/Lostdegree/cortico-world-image)（MIT），并沿用
[cortico-world-tts](https://github.com/AqualCross/cortico-world-tts) 的双协议与自检骨架，在此致谢。

## 许可

MIT，见 [LICENSE](LICENSE)。
