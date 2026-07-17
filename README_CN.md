# Vera 本地通用法律工作空间

Vera 是一个单用户、本地优先、以 Matter 为中心的 macOS 法律工作空间。它在同一个加密桌面运行时中组合文档、OCR、Assistant、Workflow、Document Studio、引用、DOCX 与备份恢复能力。

## 当前产品真源

```text
Current product:
Vera local general legal workspace

Current primary navigation:
Assistant / Matters / Workflows / Review / Settings

Current core:
Mike-derived local workspace + Vera encrypted desktop runtime

Current branch:
main

Current schema:
v25

Current milestone:
Vera General Legal Agent Preview

Legacy:
default-disabled compatibility and reusable implementation source only
```

当前产品基线为 `main`，Workspace schema v25，里程碑为 **Vera General Legal Agent Preview**。`Project` 仍是文档、对话、Workflow run、Tabular Review、模板与 Studio Draft 的技术所有者；`Matter` 是其上的法律工作语义与 Profile/Policy 投影，不引入第二套数据系统。

## 已接线能力

- Electron 管理一个 loopback Next.js renderer 和一个 loopback Express backend；renderer 保持 sandbox 与 context isolation。
- 一个 SQLCipher Workspace 数据库、加密 Blob、Keychain 模型凭证、加法 migration、备份与恢复。
- 支持 OpenAI、DeepSeek、Anthropic、Gemini 和受约束的 OpenAI-compatible 模型配置。
- 持久 Assistant job、流式响应、Stop/Retry/Regenerate、跨重启恢复和有界工具循环。
- Matter/Project 文档上传、解析与 OCR；支持 PDF、扫描 PDF、DOCX、TXT、MD、XLSX。
- Source Snapshot/Citation Anchor、Document Studio、版本、AI suggestion、接受/拒绝、DOCX 导入导出。
- Matter Profile、显式 workspace classification 与统一 inference policy。

当前 Assistant 已通过组合 registry 接入本地文档、Draft 与 Workflow 工具，支持创建/读取 Draft、生成待用户接受的修改建议以及启动/查询持久 Workflow。Matter Drafts 已接真实 Studio 数据；现有基线还提供 8 类本地法律文书模板、严格 DraftPlan 预览以及项目范围内的复制、编辑和创建 Draft API。

Assistant 现提供四个 Matter 就绪的 Starter：合同审查、自定义提取、案件时间线和法律备忘录。自定义提取会打开本地字段编辑器，字段数为 1–15，默认提供 6 个面向证据的字段；自定义提取和时间线均走同一个可持久化的 Tabular Review canonical extraction 路径。对话中可见持久任务计划，完成后的 Review/Draft 卡片可直接在浏览器下载 XLSX/DOCX，同时按当前 Matter 或 Project 的 canonical 路由打开对象。它们是有边界的本地提取和起草辅助：需要用户选择当前文档和可用模型，不构成法律结论或审批，也不代表已完成真实模型 smoke 或 Provider 验收。

法律检索工具已有固定 Provider 边界和测试接线，但法律权威尚不能进入 Assistant 当前以文档为中心的引用模型。确定性边界审计证明该路径会安全失败且不写入伪引用或 Draft；因此完整法律检索到文书闭环仍未宣称完成。详见 [`docs/local_legal_work_agent_vertical.md`](docs/local_legal_work_agent_vertical.md)。

## 法律数据源状态

仓库保留法宝与元典的 Legacy 适配器和失败处理合同，但生产激活门保持关闭。本机没有足以证明 live acceptance 的官方接口材料、完整授权权利矩阵、合法测试账号或凭证。因此 Vera **不声称任何真实法律 Provider 已接通**，也不会猜测 endpoint、使用浏览器 Cookie、抓包、网页爬虫或私有接口。

测试中的 deterministic fake Provider 只能证明合同和失败处理，不能替代真实 Provider 验收。激活所需材料见 [`docs/legal_provider_activation_requirements.md`](docs/legal_provider_activation_requirements.md)。

## 本地构建

```bash
npm install
npm run bootstrap
npm run build
```

macOS 本地包：

```bash
VERA_RELEASE_SIGNING=false ./scripts/package-desktop-mac.sh
```

当前 packaged acceptance 只证明本机 unsigned、unnotarized、local-only 构建和跨重启链路；它不是 Developer ID 签名、notarized 或可公开分发的发布证明。

## 开发与发布状态

- 简短事实状态：[`docs/status.md`](docs/status.md)
- 本轮纵向计划：[`docs/local_legal_work_agent_vertical.md`](docs/local_legal_work_agent_vertical.md)
- 路线图：[`docs/roadmap_legal_workspace.md`](docs/roadmap_legal_workspace.md)
- 桌面与发布门：[`docs/desktop_app.md`](docs/desktop_app.md)
- 许可证与来源：[`docs/license_attribution.md`](docs/license_attribution.md)

Legacy `/aletheia/*` 仅在显式兼容开关下使用。它不是当前默认导航、默认运行时或新功能的主存储。
