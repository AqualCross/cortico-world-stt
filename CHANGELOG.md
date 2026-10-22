# 更新日志 · cortico-world-stt

每个版本一节 `## <版本号>`；扩展市场按节显示更新说明。

## 0.2.0

- 新增 `dashscope-async` 协议：百炼异步文件转写。本地音频先上传换 `oss://` 临时地址，提交任务后由后台轮询。
- 新增 `delivery` 配置（`auto` / `wait` / `event`）与同名工具参数：等结果或发事件与协议解耦，可按次覆盖；`event` 下完成发 `stt.transcript`，失败或超时发 `stt.transcribe-failed`。
- 在途任务写入 `stt/pending.json`：异步任务重启后接着查，后台同步请求重启时发失败事件；状态页显示在途数量。
- 默认模型改为 `qwen3-asr-flash`（同步）。
- 异步提交返回 404 时，报错提示改用工作空间地址。
- 修正 400 提示把帮助链接里的 `model-studio` 误判成“模型名不对”；`please check url` 会提示音频地址无效。

## 0.1.2

- 修复详情页顶部徽标未随面板状态和操作结果同步更新的问题。

## 0.1.1

- 适配扩展契约 world 6：World 的 `console()` 改名 `webUi()`，manifest 的 `consoleClient` 改为 `webUiClient`，浏览器面板产物改为 `dist/webui.js`。
- 增加自描述 `describe.json`（工具与事件；由 `pnpm describe:extension` 生成），扩展市场与 `check:extension` 读它。
- 声明市场标签 `voice`。
- 需要 **Coopanion v0.2.0**（内嵌 Cortico v0.2.0）及以上；旧版会拒绝加载本包。

## 0.1.0

- 首个版本：`stt_transcribe` 工具，支持百炼 Qwen-ASR（qwen-audio / qwen3 两族请求体）与 OpenAI 兼容 `/v1/audio/transcriptions` 两种协议；转写记录入库、全文随回执交回对话。
- 「转写」与「状态」两个面板：复制文字、来源、删除、离线自检；密钥填写与试转写。
