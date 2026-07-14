# Vera P0 Mike 受控移植清单

日期：2026-07-14
状态：执行清单；以当前工作树为准，不把“文件已经存在”写成“功能已经完成”
产品边界：先把开源 Mike 做成 **Vera 品牌的本地桌面客户端**；`Project` 是承载文档、对话、工作流和表格审阅的通用容器。Legacy Vera 代码继续保留、编译和回归，但退出主导航。

## 1. 固定来源与移植规则

唯一允许的 Mike 来源是：

```text
repository: https://github.com/Open-Legal-Products/mike
remote:     upstream-mike
commit:     e32daad5a4c64a5561e04c53ee12411e3c5e7238
license:    AGPL-3.0-only
```

执行规则：

1. 不从浮动的 `upstream-mike/main` 复制代码；每个移植批次都从上面的 SHA 读取。
2. 当前仓库与该基线按受控移植处理，不执行合并，也不新增嵌套的 `mike/` 应用。
3. Mike 决定 P0 的页面结构、DOM/样式、交互流程和产品语义；Vera 决定 Electron 生命周期、本地鉴权、SQLCipher、加密 Blob、Keychain、备份和打包边界。已获得 Mike UI 使用授权，UI 采用源码移植，不做“Mike 风格”仿制。
4. UI 文件一律以固定 SHA 中的对应文件为底稿。最大限度保留组件拆分、DOM、Tailwind class、状态和交互；只允许删除云端 Auth/Profile/分享依赖、替换本地 API、改 Vera 品牌和接入 i18n。每个移植文件必须记录固定 SHA 和源路径。
5. `direct` 用于不依赖 Supabase、组织、分享或云存储的 Mike 组件/纯函数，以及 Vera 已有的安全/桌面算法；复制后仍须通过类型检查、许可证和 Vera 品牌检查。
6. `adapt` 是对直接移植文件的最小差分，不是重新设计。差分必须能归类为：`local-runtime`、`cloud-removal`、`vera-brand`、`i18n`、`security-fix` 或 `accessibility-fix`。
7. `rewrite` 只允许在 Mike 的 Supabase/Postgres/R2/S3/云鉴权实现无法进入本地客户端时使用；仍须保持 Mike 外部契约/行为，并组合 Vera 现有 service/repository/runtime，不得复制一套平行业务算法。
8. `exclude` 不进入 P0 可达代码；不能以“先复制、以后再关掉”的方式带入云依赖。
9. 新的主产品 UI 统一显示 `Vera`。`Mike` 只允许出现在许可证、归属、源码 provenance 和本移植记录中；旧的 `Aletheia` 内部名可在 Legacy 兼容代码中暂留，但不得出现在新的主导航或产品文案中。
10. 旧 `/aletheia/*` 页面不删除。它们在打包验收前保持可回退；Mike 路径通过验收后从主导航隐藏。

### 1.1 质量门禁后的复用决策

“不重复造轮子”不等于盲目沿用旧结构。每个候选实现先检查正确性、安全性、测试证据、桌面边界适配、可维护性和许可证，再按以下顺序决策：

1. 固定 Mike SHA 中已有的 UI、产品流程、wire schema 或经过验证的纯业务算法；
2. 当前 Vera/Aletheia 已有且通过质量门禁的 Electron、安全、Keychain、SQLCipher、加密文件、解析、导出、备份或任务能力；
3. 项目中已经安装并验证的成熟库，或其他已获授权、质量更高的产品实现；
4. 现有实现核心可靠但结构混乱时，抽取稳定算法到清晰接口，删除新路径对旧耦合的依赖，不整块复制混乱结构；
5. 现有实现存在数据损失、安全、恢复或维护缺陷时，以单一替代实现收敛，完成迁移和回归后淘汰重复路径；
6. 只有上述来源都不能满足目标边界时，才增加最薄 adapter 或真正缺失的实现。

代码审查必须能够回答“候选来源是什么、质量证据是什么、复用了哪一层、拒绝旧实现的具体原因、最小新增是什么”。无法回答的自建组件、重复状态机、重复解析器和重复存储层不进入主路径；同样，无法通过质量门禁的旧代码也不得仅以‘已有’为理由进入新主路径。

## 2. 当前工作树事实快照

这份快照用于防止把基础代码误报为已完成的客户端：

- Mike 基线 commit 对象已在本地 Git 对象库中，可逐文件读取。
- `backend/src/lib/workspace/` 已有 additive migrations、repository/service、权威 Blob 记录与 cleanup ledger、带 lease fence 的 Jobs pump、Mike 兼容边界和鉴权；这些仍是当前检查点的未提交工作树内容。
- `backend/src/index.ts` 已拆成薄进程入口与 `veraApplication.ts` composition root；Legacy `/aletheia` 保留，`/api/v1` 只挂载一次，并在 listen 前完成 policy/auth/audit/runtime preflight。
- `backend/src/routes/workspaceV1.ts` 已接通 Projects、Folders、Documents、版本、解析重试与 capability download；Chats、Assistant generation、Workflows、Tabular 和 Models/Settings 尚未进入该 production router。
- `frontend/src/app/lib/veraRuntime.ts`、`veraApi.ts`、`veraSse.ts`、`veraWireTypes.ts` 已形成独立本地 transport 基础；旧 `aletheiaApi.ts` 中的 Mike 风格方法不作为新客户端来源。
- `frontend/src/app/components/shared/` 有若干 Mike 衍生共享组件；部分与固定基线相同，部分已被旧 Vera 流程改动。它们存在不代表 Mike 页面已经恢复。
- `frontend/src/app/components/vera-shell/` 与两个 Mike page-chrome context 已按固定 SHA 直接移植并通过 source-lock，但仍是 dormant foundation；`/assistant`、`/projects`、`/workflows`、`/tabular-reviews`、`/settings` 页面树尚未创建，活动页面仍是 `/aletheia/*`。
- `desktop/main.js` 的启动路径当前仍是 `/aletheia/matters`。Electron 产品名和现有页面元数据已显示 Vera，但 Mike 风格的 Vera shell 还没有成为默认入口。
- 因此当前状态是“Project/Document 本地纵向链路已形成检查点，Mike shell 已有不可达源码基础，其余产品模块与页面仍待移植”，不是 P0 完成。

状态词含义：

| 状态 | 含义 |
|---|---|
| `baseline` | 来源 SHA 或既有安全能力已经确认，可作为后续输入 |
| `foundation` | 目标文件/契约存在，但尚未完成真实路由或 UI 纵向接通 |
| `dormant` | 仓库中有继承代码，但当前产品路由不可达或未接真实后端 |
| `todo` | 当前目标文件或完整行为尚不存在 |
| `excluded` | 明确不进入 P0 |

## 3. Shell 与主导航

| Mike 固定基线路径/区域 | Vera 目标 | 方式 | 阶段 | 当前状态 |
|---|---|---|---|---|
| `frontend/src/app/(pages)/layout.tsx` | 同路径，作为 Vera 主产品 layout | adapt | P2 | `foundation/dormant`：Mike layout 已移植为 `components/vera-shell/VeraShell.tsx`，尚未挂入活动页面树 |
| `frontend/src/app/components/shared/AppSidebar.tsx` | 同路径；主项仅 Assistant、Projects、Tabular Review、Workflows、Settings | adapt | P2 | `foundation/dormant`：对应 VeraSidebar 已按固定 SHA 移植，未接真实 chats/projects 数据 |
| `frontend/src/app/contexts/PageChromeContext.tsx`、`SidebarContext.tsx` | 同路径；保留 Mike 页面 chrome 行为 | direct/adapt | P2 | `foundation`：两个 context 已直接移植并通过 source-lock |
| `frontend/src/app/contexts/ChatHistoryContext.tsx` | 同路径；改接本地 chats API | adapt | P4 | `todo` |
| `frontend/src/app/components/shared/PageHeader.tsx`、`SidebarChatItem.tsx`、表格/菜单 primitives | 活跃 Mike-derived shared components | direct/adapt | P2 | `dormant`：部分 shared 文件已存在，必须逐个消除旧 API 假设 |
| `frontend/src/app/components/site-logo.tsx`、`components/chat/mike-icon.tsx`、Mike 图标/文案 | `frontend/src/components/site-logo.tsx` 及 Vera 图标资产 | rewrite | P2 | `foundation`：现有 logo 显示 Vera；新 shell 尚未使用 |
| `frontend/src/app/globals.css`、`frontend/src/app/layout.tsx` | 现有 active root layout/styles | adapt | P2 | `foundation`：Vera 元数据已存在，Mike shell 样式尚未恢复 |
| `frontend/src/app/page.tsx` | 根路径确定性跳转 `/assistant` | rewrite | P2/P7 | `todo`：切换必须在 P2 验收后完成 |
| 无对应 Mike 文件（桌面能力） | `desktop/main.js` 的 `WORKSPACE_PATH`、菜单导航、深链 | adapt existing Vera | P7 | `todo`：当前默认 `/aletheia/matters` |
| 现有 `/aletheia/*` 路由与 `frontend/src/aletheia/**` | 保留编译与回归，隐藏于主导航 | retain/exclude from nav | P2/P7 | `todo`：目前仍是主产品路径 |

## 4. Projects 与 Documents

| Mike 固定基线路径/区域 | Vera 目标 | 方式 | 阶段 | 当前状态 |
|---|---|---|---|---|
| `frontend/src/app/(pages)/projects/page.tsx` | 同路径，Vera Projects 总览 | adapt | P2 | `todo` |
| `frontend/src/app/(pages)/projects/[id]/layout.tsx`、`page.tsx` | 同路径；Project 为通用容器，保留 Mike tabs/IA | adapt | P2 | `todo` |
| `frontend/src/app/components/projects/ProjectsOverview.tsx`、`NewProjectModal.tsx` | 同区域；去除 people/share，改接 `/api/v1/projects` | adapt | P2 | `todo` |
| `ProjectWorkspace.tsx`、`ProjectExplorer.tsx`、`ProjectPageParts.tsx`、各 Project table | 同路径；真实 folders/documents/chats/reviews counts | adapt | P2 | `todo` |
| `ProjectDocumentsView.tsx`、`DocumentSidePanel.tsx` | 同路径；本地上传、版本、预览、下载、移动、重命名 | adapt | P2 | `todo` |
| `frontend/src/app/components/shared/FileDirectory.tsx`、`useDirectoryData.ts`、`VersionChip.tsx`、`views/*` | 继续作为 Project/Document 共享层 | direct/adapt | P2 | `dormant`：若干文件已存在，但依赖旧根 API；预览 views 尚未完整恢复 |
| `frontend/src/app/components/modals/AddDocumentsModal.tsx`、`AddProjectDocsModal.tsx` | Vera 上传/关联对话框 | adapt | P2 | `foundation/dormant`：共享版本存在，仍需真实本地 API 验收 |
| `frontend/src/app/lib/mikeApi.ts` 的 projects/documents 方法 | 新的 `/api/v1` Workspace client；不要继续扩张巨型 `aletheiaApi.ts` | rewrite | P2 | `dormant`：旧方法存在但 base/path 不正确 |
| `backend/src/routes/projects.ts` | 由薄 `workspaceV1.ts` adapter 提供 `/api/v1/projects`，只调用 runtime port | rewrite | P1 | `foundation`：CRUD/archive/folders 已接通；待 Projects UI E2E 后标完成 |
| `backend/src/routes/documents.ts`、`downloads.ts` | 由薄 `workspaceV1.ts` adapter 提供 Documents/版本/短期 capability 下载 | rewrite | P1 | `foundation`：真实本地 service 已接通；待 UI、重启和打包 E2E 后标完成 |
| `backend/src/lib/documentVersions.ts` | `workspace/repositories/documents.ts` + `services/documents.ts` | rewrite | P1 | `foundation`：上传、版本、解析、删除依赖协调与 claim fence 已审计 |
| `backend/src/lib/storage.ts` 的产品行为 | `workspace/blobStore.ts`、`localWorkspaceBlobStore.ts`、`repositories/blobRecords.ts` | rewrite | P1 | `foundation`：不得复制 R2 实现 |
| `backend/src/lib/upload.ts`、`convert.ts`、`officeText.ts`、`spreadsheet.ts` | 受 document service/job 调用的安全解析与格式能力 | direct/adapt | P1/P2 | `foundation`：已有 Vera 上传/转换能力；Mike 文档纵向链路尚未由 router 验收 |
| Mike project/folder/document 数据语义 | `workspace/migrations/*`、`repositories/projects.ts`、`documents.ts`、相关 services | rewrite | P1 | `foundation`：递归删除、运行中 job 协调、Project 所有权 guard 和 read model 已具备；待 UI/重启 E2E 后标完成 |

## 5. Assistant

| Mike 固定基线路径/区域 | Vera 目标 | 方式 | 阶段 | 当前状态 |
|---|---|---|---|---|
| `frontend/src/app/(pages)/assistant/page.tsx`、`chat/[id]/page.tsx` | 同路径，Vera 全局 Assistant | adapt | P4 | `todo` |
| `frontend/src/app/(pages)/projects/[id]/assistant/**` | 同路径，Project-scoped Assistant | adapt | P4 | `todo` |
| `frontend/src/app/components/assistant/**` | 同路径；保留 Mike 对话、引用、停止/重试/编辑体验 | adapt | P4 | `todo` |
| `frontend/src/app/hooks/useAssistantChat.ts`、`useGenerateChatTitle.ts`、`useFetchSingleDoc.ts`、`useFetchDocxBytes.ts` | 同路径；改接本地 bearer、SSE、download capability | rewrite/adapt | P4 | `todo` |
| `frontend/src/app/lib/mikeApi.ts` 的 chats/stream 方法与 SSE event shapes | 独立 Workspace API client + typed SSE decoder | rewrite | P4 | `dormant`：旧客户端方法仍在 `aletheiaApi.ts`，没有活动页面 |
| `backend/src/routes/chat.ts`、`projectChat.ts` | `/api/v1/chats` 资源树和 generation actions | rewrite | P1/P4 | `todo` |
| `backend/src/lib/chat/citations.ts`、`types.ts` 的 Mike 文档引用语义 | `workspace/mikeCompatibility.ts`、chat service、message sources | adapt/rewrite | P1/P4 | `foundation`：wire 兼容层存在；没有生产 streaming runtime |
| `backend/src/lib/chat/contextBuilders.ts`、`streaming.ts` | 本地 FTS retrieval + model gateway + persisted jobs/messages | rewrite | P4 | `todo`；不得复制 Supabase/MCP/CourtListener 路径 |
| `backend/src/lib/chat/tools/documentOps.ts` | 有界的本地文档读取/编辑 service | rewrite | P4 | `todo` |
| `backend/src/lib/llm/**` 的 provider streaming 语义 | `backend/src/lib/modelGateway/**` | adapt/rewrite | P3/P4 | `todo` |

## 6. Workflows

| Mike 固定基线路径/区域 | Vera 目标 | 方式 | 阶段 | 当前状态 |
|---|---|---|---|---|
| `frontend/src/app/(pages)/workflows/page.tsx` | 同路径，Vera workflow list | adapt | P5 | `todo` |
| `workflows/assistant/[id]/page.tsx`、`workflows/tabular-review/[id]/page.tsx` | 同路径，按 Mike 类型打开编辑器 | adapt | P5 | `todo` |
| `frontend/src/app/components/workflows/**`，但不含开源提交/分享 | 同路径；保留 list/detail/picker/editor/zip 交互 | direct/adapt | P5 | `todo` |
| `backend/src/routes/workflows.ts` | `/api/v1/workflows`、`/workflow-runs` | rewrite | P1/P5 | `todo` |
| `backend/src/lib/systemWorkflows.ts` | Vera 内置模板 seed；保留 Mike workflow metadata 语义 | adapt | P5 | `todo`：不得把组织/开源发布元数据变成多用户能力 |
| Mike workflow CRUD/hide/product metadata | `workspace/repositories/workflows.ts`、`services/workflows.ts` | rewrite | P1 | `foundation` |
| Mike workflow execution | persisted `jobs` + `workflow_runs`/`workflow_step_runs` | rewrite | P1/P5 | `foundation`：状态模型存在；生产 pump/model executor 尚未纵向接通 |

## 7. Tabular Review

| Mike 固定基线路径/区域 | Vera 目标 | 方式 | 阶段 | 当前状态 |
|---|---|---|---|---|
| `frontend/src/app/(pages)/tabular-reviews/**` | 同路径，全局 Vera Tabular Review | adapt | P6 | `todo` |
| `frontend/src/app/(pages)/projects/[id]/tabular-reviews/**` | 同路径，Project-scoped reviews | adapt | P6 | `todo` |
| `frontend/src/app/components/tabular/**` | 同路径；保留列、cell retry、citations、review chat、export 体验 | direct/adapt | P6 | `todo` |
| `frontend/src/app/components/tabular/exportToExcel.ts` | 浏览器下载或后端 export capability；中文文件名安全 | adapt | P6 | `todo` |
| `frontend/src/app/lib/mikeApi.ts` 的 tabular 方法/SSE | 独立 Workspace API client | rewrite | P6 | `dormant`：旧方法存在，无活动页面/真实路由 |
| `backend/src/routes/tabular.ts` | `/api/v1/tabular-reviews` 及 generation/chat/cell actions | rewrite | P1/P6 | `todo` |
| Mike tabular persistence/behavior | `workspace/repositories/tabular.ts`、`services/tabular.ts` | rewrite | P1 | `foundation` |
| Mike cell generation/retry SSE | persisted idempotent jobs + Mike-compatible events | rewrite | P6 | `foundation`：数据/兼容基础存在；没有生产 executor/router |
| Mike XLSX/CSV export semantics | `workspace/tabularExport.ts` + download capability | adapt/rewrite | P6 | `foundation`：实现文件存在，尚未由 HTTP/UI E2E 验收 |

## 8. Settings、模型与本地桌面控制

| Mike 固定基线路径/区域 | Vera 目标 | 方式 | 阶段 | 当前状态 |
|---|---|---|---|---|
| `frontend/src/app/(pages)/account/models/page.tsx` | `frontend/src/app/(pages)/settings/page.tsx` 的 Models 区 | adapt | P3 | `todo` |
| `frontend/src/app/(pages)/account/page.tsx`、`features/page.tsx` 中可用的产品偏好 | `/settings` 的 General/Appearance 区 | adapt | P3 | `todo` |
| Mike account security/privacy-data/connectors/api-keys 页面 | 不进入 P0 主 UI；由 Vera Local Data/Backup/Diagnostics/Models 重新组织 | exclude/rewrite | P3 | `excluded`（模型 key 录入另行重写） |
| `frontend/src/app/components/assistant/ModelToggle.tsx`、`hooks/useSelectedModel.ts`、`lib/modelAvailability.ts` | Vera model profile selector/status | adapt | P3 | `foundation/dormant`：selected-model hook 存在，新的 settings/provider flow 不存在 |
| `backend/src/lib/llm/{models,index,openai,claude,gemini}.ts` | `backend/src/lib/modelGateway/**` provider adapters | adapt/rewrite | P3 | `todo` |
| `backend/src/lib/userSettings.ts` 的 model preferences | `workspace/repositories/settings.ts`、`modelProfiles.ts` 及 services | rewrite | P1/P3 | `foundation` |
| `backend/src/lib/userApiKeys.ts` | Keychain-only `CredentialStore`；数据库只存 credential ref/status | exclude/rewrite | P3 | `todo`：禁止复制加密 key 数据表方案 |
| 无对应 Mike 文件 | `desktop/macOsKeychain.js` 与最小 IPC | adapt existing Vera | P0/P3 | `baseline`：fail-closed provisioning 已有；模型凭据专用桥仍 `todo` |
| 无对应 Mike 文件 | Vera backup/restore、data/log directory、diagnostics settings | adapt existing Vera | P3/P7 | `foundation`：桌面能力已有，新的 `/settings` UI 未接入 |

## 9. Auth、API composition 与 preload

| Mike 固定基线路径/区域 | Vera 目标 | 方式 | 阶段 | 当前状态 |
|---|---|---|---|---|
| `backend/src/middleware/auth.ts` | `backend/src/middleware/workspaceAuth.ts`，仅 loopback + per-launch bearer + fixed local principal | rewrite | P1 | `foundation`：已在单一 `/api/v1` mount 上启用并通过 application/auth audit |
| `frontend/src/app/contexts/AuthContext.tsx`、Supabase session 获取 | 无登录 session；由 desktop preload 提供 launch token | exclude/rewrite | P1/P2 | `todo`：Legacy client 已能取 token，新的 Workspace client 未拆出 |
| `frontend/src/app/lib/supabase.ts` | 无；不能出现在新产品 import graph | exclude | P1/P2 | `excluded` |
| `backend/src/index.ts` 的 Mike root routers | `veraApplication.ts` runtime composition；只挂载一次 `/api/v1` | rewrite | P1 | `foundation`：已挂载，Projects/Documents 可用；其余模块 route 待补 |
| Mike route names `/projects`、`/single-documents`、`/chat`、`/tabular-review`、`/workflows` | canonical `/api/v1/*`；必要的 wire alias 只在 router 边界提供 | adapt/rewrite | P1 | `foundation`：`mikeCompatibility.ts` 存在，HTTP composition 不存在 |
| `frontend/src/app/lib/mikeApi.ts` | `veraApi.ts` 小型 typed Workspace client，base = preload runtime + `/api/v1` | rewrite | P1/P2 | `foundation`：transport/auth/SSE 已有；资源方法随直接 UI 移植逐项加入 |
| 无对应 Mike 文件 | `desktop/preload.js` 的 token、backup、受控 native 操作 | adapt existing Vera | P1/P3/P7 | `foundation`：现有 `window.aletheiaDesktop` 为 Legacy bridge；新主 UI 只增加必要能力，不暴露路径/secret |
| 无对应 Mike 文件 | `frontend/src/global.d.ts` 的 desktop bridge types | adapt existing Vera | P2/P3 | `todo`：Vera 命名迁移须兼容旧页面，不能一次破坏 Legacy |
| Mike `/download/:token` 行为 | `/api/v1/downloads/:token` + `workspace/downloadCapabilities.ts` | rewrite | P1/P2 | `foundation`：capability 与 router 已接通；待 UI/打包下载 E2E |
| Mike `backend/schema.sql` 与所有 `backend/migrations/*.sql` | `workspace/migrations/*` 的 additive SQLCipher migrations | rewrite | P1 | `foundation`：不直接导入 Postgres/RLS schema |

## 10. 明确排除的云端和多用户依赖

以下行的 `exclude` 是架构决定，不是延期后默认启用：

| Mike 固定基线路径/能力 | P0 处理 | Vera 替代/说明 | 状态 |
|---|---|---|---|
| `backend/src/lib/supabase.ts`、`frontend/src/app/lib/supabase.ts`、Supabase Auth/Postgres/RLS | exclude | SQLCipher repositories + local principal | `excluded` |
| `backend/src/lib/storage.ts` 的 Cloudflare R2/S3 client | exclude | encrypted `WorkspaceBlobStore` | `excluded` |
| `frontend/src/app/login`、`signup`、`verify-mfa`；MFA gates/popups | exclude | 单用户桌面启动鉴权，无登录页 | `excluded` |
| organisations、people、`shared_with`、share modals/routes、user lookup | exclude | P0 不共享；Project 为单用户通用容器 | `excluded` |
| account deletion/export 的 SaaS 用户语义 | exclude | 本地 workspace backup/restore 与显式删除策略 | `excluded` |
| `backend/src/lib/userApiKeys.ts` 的数据库 secret | exclude | macOS Keychain-only credential store | `excluded` |
| `backend/src/lib/mcp/**`、`mcpConnectors.ts`、account connectors/OAuth UI | exclude | P0 不提供 MCP/OAuth/connectors | `excluded` |
| `backend/src/lib/courtlistener.ts`、`routes/caseLaw.ts`、CourtListener chat tools/prompts | exclude | P0 只基于用户本地文档；法律数据库以后另立范围 | `excluded` |
| `OpenSourceWorkflowModal.tsx`、workflow open-source submission/share APIs | exclude | 本地 workflow CRUD/run；无发布/分享 | `excluded` |
| `backend/nixpacks.toml`、`frontend/open-next.config.ts`、Cloudflare/browser deployment | exclude from desktop package | 只保留开发兼容，不进入 P0 desktop runtime | `excluded` |
| server-wide provider API keys、Resend/contact SaaS、远程 user data cleanup/export | exclude | 用户显式配置模型；secret 不进 renderer/log/backup | `excluded` |
| Mike Postgres schema/migrations 和 RLS policy | exclude direct import | 只迁移产品语义到 additive SQLite/SQLCipher schema | `excluded` |

## 11. 依赖顺序与完成定义

```text
P1 local runtime + /api/v1
  -> P2 shell + Projects/Documents
      -> P3 Settings/model gateway
          -> P4 Assistant
              -> P5 Workflows
                  -> P6 Tabular Review
                      -> P7 packaged desktop default-route switch
```

任何一行只有同时满足以下条件才可从 `foundation/dormant/todo` 改为完成：

- active route 可达，使用真实本地 service/repository，不使用 production fixture；
- refresh/restart 后数据仍存在，错误、空态、取消和重试可观察；
- 没有 Supabase、R2/S3、组织、分享、OAuth/MCP 或服务器级 provider secret 进入新 import graph；
- UI、窗口标题、菜单、通知、导出名和打包产物均显示 Vera；
- 对应 backend contract/audit、frontend build/E2E 和 packaged desktop gate 通过；
- Legacy 路由仍可回归，但不再由新导航调用。

## 12. 固定基线验证命令

### 12.1 每个移植批次先验证来源

```bash
MIKE_SHA=e32daad5a4c64a5561e04c53ee12411e3c5e7238
test "$(git cat-file -t "$MIKE_SHA")" = commit
test "$(git show -s --format=%H "$MIKE_SHA")" = "$MIKE_SHA"
git show -s --format='source=%H date=%cs subject=%s' "$MIKE_SHA"
git ls-tree -r --name-only "$MIKE_SHA" -- frontend/src/app backend/src | sort
test ! -d mike
git diff --check
```

### 12.2 当前 Workspace 基础的固定回归组

这些文件和命令在当前工作树中实际存在；后续应收敛成稳定的 `package.json` 聚合脚本，未收敛前使用这一组明确命令：

```bash
(
  cd backend
  npx tsx src/scripts/veraWorkspaceMigrationAudit.ts
  npx tsx src/scripts/veraWorkspaceBlobStoreAudit.ts
  npx tsx src/scripts/veraWorkspaceBlobRecordsAudit.ts
  npx tsx src/scripts/veraWorkspaceDocumentsAudit.ts
  npx tsx src/scripts/veraWorkspaceJobStateAudit.ts
  npx tsx src/scripts/veraWorkspaceJobsPersistenceAudit.ts
  npx tsx src/scripts/veraWorkspaceCoreRepositoriesAudit.ts
  npx tsx src/scripts/veraWorkspaceWorkflowTabularAudit.ts
  npx tsx src/scripts/veraWorkspaceContractAudit.ts
  npx tsx src/scripts/veraMikeCompatibilityAudit.ts
  npx tsx src/scripts/veraWorkspaceAuthAudit.ts
  npx tsx src/scripts/veraWorkspaceDownloadCapabilitiesAudit.ts
)
npm run build --prefix backend
```

### 12.3 UI/桌面每批固定门禁

```bash
npm run lint --prefix frontend
npm run build --prefix frontend
npm run test:product-rename --prefix desktop
npm run test:keychain-provisioning --prefix desktop
git diff --check
```

### 12.4 切换默认入口前必须补齐并执行的 P0 E2E

下列测试名是固定验收契约；当前对应 spec 尚未全部存在，因此不能据此宣称 P2-P7 完成：

```bash
npm --prefix frontend run test:aletheia:ui -- tests/vera-shell.spec.ts
npm --prefix frontend run test:aletheia:ui -- tests/vera-projects.spec.ts
npm --prefix frontend run test:aletheia:ui -- tests/vera-assistant.spec.ts
npm --prefix frontend run test:aletheia:ui -- tests/vera-workflows.spec.ts
npm --prefix frontend run test:aletheia:ui -- tests/vera-tabular-review.spec.ts
npm --prefix desktop run test:sqlcipher-runtime
npm --prefix desktop run test:legacy-migration
npm --prefix desktop run check:package-hygiene
npm --prefix desktop run test:packaged-app
npm --prefix desktop run test:packaged-backup
npm --prefix desktop run test:packaged-restore-fail-closed
```

最终 packaged E2E 必须在 Vera 客户端中完成并跨重启验证：创建 Project，上传并解析至少两个文档，完成 Assistant stream，运行一个 Workflow，运行一个 2 文档 × 2 列的 Tabular Review，关闭并重新打开应用，确认对象、引用和结果全部仍可读取。只有这一步通过后，`desktop/main.js` 才能把默认路径切到 `/assistant`。
