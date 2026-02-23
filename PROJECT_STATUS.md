# Project Status
Phase: 2 — Dual-Session Architecture
Current: M2.3 complete
Next: M3.1
Last updated: 2026-02-23

## 当前架构

### 外部对话（Sonnet）
- 模型: claude-sonnet-4-20250514
- 人格: SOUL.md（含 [thinking:] 思考过程）
- 短期记忆: per-user Map, 最近 20 条消息, 30 分钟超时
- 支持图片识别（Discord 附件 → Claude vision）

### 内部专员（DeepSeek, 无历史, 每次独立调用）
- 回忆员 (recall) — 从文件摘要中找相关文件, 返回 JSON 文件名数组
- 提取员 (extract) — 从原始资料中提取精华, 每文件 150 字限制, 最多 5 个文件
- 压缩员 (compress) — 对话压缩为 summary + facts JSON, 规则见 COMPRESSOR_PROMPT.md
- 诊断员 (diagnose) — 分析用户不满的原因
- 方案员 (propose) — 提出改进建议
- 裁判员 (judge) — 一次性决策有完整权限, 系统级修改只能建议

### 调度器 (session-manager)
消息流程: 关键词匹配 → (未命中则)回忆员 → 提取员 → 外部对话
不满检测: 9 个关键词触发, 提示用户 /evolve

### 图书馆 (library/)
- 格式: md 文件, frontmatter 含 tags + summary, 正文为内容
- 支持子目录 (library/sessions/)
- 自动压缩: 30 分钟超时 → DeepSeek 压缩 → 存入 library/sessions/session-*.md → 清空短期记忆

### 三贤人 (/evolve)
diagnose → propose → judge
- 一次性决策: 重新搜索、全文加载、换关键词, 有完整执行权
- 系统级建议: 创建文件、修改 tag、改配置, 只能建议, 发 #bwf-evolution 等人类审批

## Discord 频道
- #bornwithfire — 用户对话
- #bwf-debug — 调试日志（流程追踪, 成本计算）
- #bwf-evolution — 系统改进建议（需人类审批）

## 命令列表
- /reset — 清空对话历史
- /compress — 手动压缩对话（DeepSeek, summary + facts）
- /status — 显示状态（历史条数, 图书馆文件数, 运行时间）
- /recall <问题> — 跳过关键词, 强制调用回忆员
- /fullload <文件名> — 跳过提取员, 全文注入 context
- /library — 列出图书馆所有文件和摘要
- /evolve — 触发三贤人自检
- /edit-compressor — 查看/编辑压缩员规则

## 已完成里程碑
- M0.2 — VPS environment verified
- M1.1 — Discord Bot 骨架
- M1.2 — Claude API 接入
- M1.3 — 对话历史（短期记忆）
- M1.4 — 图书馆（长期记忆）
- M1.5 — 手动对话控制
- M2.1 — 双 session 架构
- M2.2 — 调试频道
- M2.3 — 大更新（压缩员迁移, 自动压缩, 多文件提取, 三贤人, 不满检测）

## 关键文件
- agent/src/index.js — Discord 入口, 命令路由
- agent/src/session-manager.js — 调度中心
- agent/src/sessions/external.js — Sonnet 外部对话
- agent/src/sessions/internal.js — DeepSeek 内部专员 x6
- agent/src/library.js — 图书馆读取/搜索
- agent/SOUL.md — 人格定义
- agent/COMPRESSOR_PROMPT.md — 压缩员规则
- agent/library/ — 长期记忆文件
- agent/library/sessions/ — 自动压缩存档
