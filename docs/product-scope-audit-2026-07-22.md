# Vera 产品收敛与核心闭环审计（2026-07-22）

## 结论

Vera 当前的主导航、页面密度和 Matter 基础结构已经保持 Mike 的可识别性，不需要重新设计或增加另一套工作台。当前最有价值的工作不是扩充页面，而是把现有能力连成一条可验证的交付链：

`Matter 材料 → Assistant / Tabular Review / Work Task → Word / Excel → 回到原始来源 → 必要时批准或退回`

本轮确认的产品级缺口按优先级排序：

1. **P0 — Work Task 引用校验必须真正读取当前文档版本并重定位引文。** 仅检查引用字段、文档 ID 或版本 ID 不能证明来源仍然有效。
2. **P0 — 普通 Assistant 不应显示 Thought process、工具名、MCP 名称或工具调用流水。** 用户只需要看到正在处理、可理解的进度、最终成果、来源、阻塞和错误。
3. **P1 — Tabular Review 结果需要保存回当前 Matter，才能继续用于 Memo、Word 和 Work Task。** 应复用现有 Matter Document 上传与 Artifact 关联，不新建页面、表或 API。
4. **P1 — 通用 Connectors 控制台不应出现在普通设置导航。** 直接路由和现有凭证/权限边界保留，未来只在具体法律能力成立时开放入口。

## 审计范围与证据

- 产品权威约束：`AGENTS.md`、`PRODUCT.md`
- Vera 运行环境：`https://localhost:3000`
- Mike 视觉基线：未修改的 Mike v0.4 前端，`http://localhost:3100`
- 视口：1280×800；补充检查 393×900、约 125% 与 150% 等效宽度
- 合成测试 Matter：`Tabular Source QA — Synthetic`
- 截图目录：`docs/screenshots/product-scope-audit-2026-07-22/`

没有使用用户真实合同、真实客户数据或用户原始 Word 文档。键盘遍历在本轮 Browser 环境中未能完整证明，因此本报告不作完整 WCAG 或键盘验收声明。

## 逐步审计

| 步骤 | 页面 / 流程 | 结论 | 健康度 |
|---|---|---|---|
| 1 | Assistant 首页 | Vera 保留 Mike 的侧栏、中心输入框、快捷动作和视觉密度；Ask / Work 是克制增量。 | 良好 |
| 2 | Projects / Matter 列表 | 表格结构和操作与 Mike 一致；无需改成新的 Matter 仪表盘。 | 良好 |
| 3 | Matter Documents | 当前 Matter 名称、四个工作区入口和文档范围可辨识。 | 良好 |
| 4 | Matter Tabular Reviews | 长中文标题能够截断；窄窗无页面级横向溢出。 | 良好，表格列在极窄宽度仍会压缩 |
| 5 | Matter Work Tasks | 空状态清楚；创建后会进入 Assistant Work 模式并保留 Matter 选择。 | 良好 |
| 6 | Workflows / Library / 全局 Tabular | 与 Mike 的主导航和表格语言一致；当前不应隐藏或重构。 | 良好 |
| 7 | Assistant 执行消息 | 现有代码会展示 Thought process、工具和连接器名称，与产品定义冲突。 | 需修复（P0） |
| 8 | Work Task Verifier | 现有确定性检查未完整证明引用文本能在当前来源中重新定位。 | 需修复（P0） |
| 9 | Tabular → Matter → Memo | 当前 Excel 仅浏览器下载，引用标记会丢失，无法自然进入后续成果链。 | 需修复（P1） |
| 10 | Settings | Vera 保留 Mike 的页面布局，但隐藏未证明有普通用户价值的通用 Connectors 入口。 | 已收敛 |

## 信息架构决策

### 保留

- 主导航：Assistant、Projects、Library、Tabular Review、Workflows。
- Matter 四个现有区：Documents、Chats、Tabular Reviews、Work Tasks。
- Work Task 的目标、3–6 步计划、进度、成果、来源核查和最终阻塞。
- Word 加载项、Office 登录入口、认证、Matter ownership、文件路径验证和最终导出门禁。

### 隐藏但不删除

- Assistant 的 reasoning、tool-call 和 MCP 内部事件展示；底层事件继续用于恢复与诊断。
- `/account/connectors` 的普通设置入口；路由、凭证存储和后端能力保留。
- 现有未挂载的实验路由和历史安全/隐私直达页；不得进入导航或宣传。

### 不做

- 新建 Agent Console、Evidence Center、Governance、Audit 或 Security Center。
- 为 Tabular 成果另建数据表、成果页或导出 API。
- 在普通页面显示哈希、内部 ID、本地优先或加密状态。
- 因 UI 收敛而改变 API、认证、权限、安全边界或法律免责声明。

## 本轮实际修改

### 1. 真实引用重定位

Verifier 已复用现有文档/电子表格提取与引文定位能力，读取引用指向的具体版本，并把 `exact` 作为唯一通过状态：

- PDF 只在引用指定的单页或连续页码范围内重定位；
- Excel 只在引用指定的 sheet 与 A1 cell / range 内重定位；
- DOCX 因现有提取没有可靠分页信息，进行全文逐字引文检查，不伪造页码精度；
- 缺引文、来源不可读、错误或已删除版本、错误页/单元格、版本漂移均 fail closed；
- 不再为缺失引用自动补写当前 `version_id`。

### 2. Assistant 进度收敛

进行中的 reasoning、tool-call、MCP 事件已合并为单一 `Working…` 状态；完成后不展示内部流水。用户输入请求、成果创建/下载/编辑、Workflow 完成状态、权威来源结果、最终回答、引用和可理解错误仍可见。真实浏览器 QA 中，合成消息里的 reasoning、工具名和 MCP 名称均未出现在折叠或展开结果中。

### 3. Tabular 保存回 Matter

Excel 导出现在保留 `Review` 与 `Citations` 两张工作表。Review 使用可读引用编号；Citations 保存原文件名、页码/单元格、逐字引文和对应 Review 单元格。Matter 内 Review 可通过现有 Actions 菜单保存为当前 Matter Document，再由现有 Assistant attachment picker 或 Work Task 使用。真实浏览器 QA 已完成保存并在 Matter Documents 中确认 `.xlsx`；同时修复了 Multer 对 UTF-8 中文上传文件名的 latin1 误解码，复测后长中文文件名显示正确。

### 4. 设置入口收敛

普通设置仅保留 General、Features、Model Preferences、API Keys。Connectors 直接路由仍可用于未来明确的法律/DMS 连接器，不作为通用 Agent 平台入口。

## 验证结果

- Backend verifier guards、Agent Task runner、review version、model tests：通过。
- Backend 中文上传文件名测试：3/3 通过。
- Backend production TypeScript build：通过。
- Frontend Tabular / citation / Excel 测试：8/8 通过。
- Frontend Assistant 事件呈现测试：3/3 通过。
- Frontend TypeScript：通过。
- Frontend production build：使用现有开发配置明确退出 0，26/26 静态页面生成完成。
- 真实浏览器：Tabular `Save Excel to Matter` 成功；Matter Documents 可见保存结果；中文文件名修复复测成功；Assistant 折叠/展开均不显示 reasoning、工具名或 MCP 名称，保留成果和权威来源结果。

## 响应式、可访问性和键盘检查

- 393×900 的 Matter Documents 与 Tabular 列表均无页面级横向溢出。
- 约 125%（1024px 等效宽度）和 150%（853px 等效宽度）无页面级横向溢出。
- 长中文 Matter / Review 标题采用截断而非撑破容器。
- 设置导航隐藏 Connectors 后保持与 Mike 相同的双栏密度和焦点结构。
- Tabular Actions 已通过键盘打开，方向键可把可见焦点移动到 `Save Excel to Matter`，Escape 可关闭菜单；浏览器原生 focus outline 可见。全应用 Tab 顺序和所有“回到来源”路径仍不是本轮完整 WCAG 验收范围。

## 法律、安全和数据边界

本轮产品收敛不改变后端 API、认证、权限、Matter ownership、安全边界、Keychain 存储、文件路径验证、最终导出门禁或法律免责声明。隐藏技术细节只改变普通 UI 的呈现，不移除底层恢复、诊断或确定性验证。用户选择云模型时，数据外发事实仍应在配置或实际外发点如实说明。
