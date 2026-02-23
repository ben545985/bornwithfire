# Project Status
Phase: 2 — Dual-Session Architecture
Current: M2.3 complete
Next: M3.1
Last updated: 2026-02-23

## Completed
- M0.2 — VPS environment verified
- M1.1 — Discord Bot 骨架 (discord.js, pm2, echo reply in #bornwithfire)
- M1.2 — Claude API 接入 (claude-sonnet-4-20250514, SOUL.md system prompt, token logging)
- M1.3 — 对话历史 (per-user Map, 最近20条, 30分钟超时清空)
- M1.4 — 图书馆/长期记忆 (library/ 目录, tag匹配, system prompt注入)
- M1.5 — 手动对话控制 (/reset, /compress, /status 命令)
- M2.1 — 双session架构 (DeepSeek内部recall+extract, Sonnet外部回复, session-manager调度)
- M2.2 — 调试频道 (#bwf-debug, 流程追踪, 成本计算)
- M2.3 — 大更新：
  - 压缩员移到 DeepSeek (COMPRESSOR_PROMPT.md, JSON输出含summary+facts)
  - 自动压缩 (30分钟超时→压缩存library/sessions/→清空短期记忆)
  - 多文件逐个提取 (最多5个文件, 每个150字限制)
  - /fullload 命令 (跳过提取员, 全文注入context)
  - /library 命令 (列出图书馆文件)
  - 不满检测 + #bwf-evolution频道 (关键词触发)
  - /evolve 命令 (三session投票: diagnose→propose→judge)
  - /edit-compressor 命令 (实时编辑压缩员规则)

## 命令列表
- /reset — 清空对话历史
- /compress — 手动压缩对话
- /status — 显示状态
- /recall <问题> — 强制调用回忆员
- /fullload <文件名> — 加载文件全文到context
- /library — 列出图书馆文件
- /evolve — 触发系统自检
- /edit-compressor — 编辑压缩员规则
