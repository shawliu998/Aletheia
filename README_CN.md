# Vera 民商事诉讼工作台

Vera 是一个本地优先、由律师主导的民商事诉讼工作台。

它把案卷材料转化为可验证、可复核、可审计的事实、证据、请求权与抗辩、法律研究、程序期限和诉讼文书。

这不是普通法律聊天机器人。V1 只开放 `civil_litigation` 民商事诉讼产品；早期合同审阅、合规、尽调和通用 Agent Studio 能力与导航、设置、Demo 和案件路由隔离，待后续独立验证后再扩展。

## 演示路径

1. 打开 `/aletheia`。
2. 打开自动创建的 Civil Litigation Demo，或新建一个民商事诉讼案件。
3. 导入起诉状、合同、付款凭证、往来函件和法院通知。
4. 依次复核事实与证据、请求权与抗辩、法律研究、程序事件与期限。
5. 生成诉讼文书或庭审材料，完成人工复核和审批后导出审计包。

## 当前实现

- Civil Litigation：当前唯一产品入口，覆盖接案、案卷导入、事实证据、请求权与抗辩、法律研究、程序期限、文书庭审、人审、审批和审计导出。
- 本地 SQLite 仓储：包含 matters、documents、work products、evidence、reviews、audit events，以及持久 Agent runs、steps、tool calls 和 human checkpoints。
- 后端 API：`/aletheia/matters` 和 `/aletheia/tool-adapter`，支持事项列表、创建事项、读取事项详情、保存结构化 work product、添加 review、追加 audit event、本地文档上传与检索、证据落库、Evidence Matrix、Draft Memo、审批 checkpoint、Matter Memory、Matter Playbooks，以及最小权限 Tool Adapter 调用。
- 新建事项会自动生成 deterministic Initial Agent Plan work product，让真实事项从可复核的工作流脚手架开始。
- 后端持久化已切到 Aletheia repository 边界；纯本地产品只使用 SQLite/filesystem 实现，支持 matters、work products、source-linked evidence items、reviews、audit events、agent runs、Matter Memory、Matter Playbooks 的本地持久化，并支持本地文档上传、文本解析、chunk、SQLite FTS5 搜索、检索结果证据落库、Evidence Matrix work product 生成、Legal Draft Memo、Compliance Register、Red Flag Memo 生成、Final Memo 人审门控、Agent Run Trace 可视化和 Audit Pack 人审审批门控。
- Aletheia Tool Adapter 已提供最小权限工具面：`list_matters`、`read_matter`、`search_matter_documents`、`read_evidence_item`、`create_work_product`、`add_review_tag`、`append_audit_event`、`export_audit_pack`。默认不开放 terminal、browser、外部 web search、email 或破坏性文件操作。
- 本地模式会把 Audit Pack、Feedback Export、Final Memo 等 export 类 work product 写入 `.data/aletheia/exports/<matterId>/`，并在 audit event 中记录路径。
- Matter Queue 只显示本地数据库中的 `civil_litigation` 案件；旧类型事项保留在存储中但不进入民诉主链路，后端不可用时不会注入 fallback 数据。
- Demo workspace 支持审批后导出 Audit Pack、Feedback Eval Dataset 和 Final Memo，方便展示可复核交付物与 badcase/eval 闭环。

## 本地运行

```bash
cd frontend
npm install
npm run dev
```

访问：

```text
http://localhost:3000/aletheia
```

当前 demo 不依赖外部 API key。

当前阶段、阻塞项和发布前验证以 `docs/status.md` 为准。

## 许可证与归因

本项目保留原开源项目许可证和归因说明。详见 `docs/license_attribution.md`。
