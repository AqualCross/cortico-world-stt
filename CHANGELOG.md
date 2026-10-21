# 更新日志 · cortico-world-stt

每个版本一节 `## <版本号>`；扩展市场按节显示更新说明。

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
