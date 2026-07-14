# Vera 法律研究备忘录 DOCX Sol 视觉主审

日期：2026-07-13

## 结论

**Sol 结论：PASS**

DOCX 导出被收敛在既有“4. 律师确认摘录与研究结论”的工作产品行内。仅 `legal_qa_answer`、`status=accepted` 且 `stale_at=null` 的记录显示带 Download icon 的“导出备忘录 DOCX”按钮；过期、依据不足和未采纳记录没有导出入口。未新增导航、卡片、表单或第二次审批。

前端只做可见入口的粗粒度门禁；`ready_for_review`、全部 review accepted、current inputs、hash 与 exact approval audit 等最终资格继续由后端专用端点 fail closed。研究备忘录没有复用法律意见书的 export 或 download 路径。

## 流程检查

1. **可导出入口：PASS。** 已采纳且未过期的 `legal_qa_answer` 行显示唯一导出按钮；按钮为普通灰阶边框、Download icon 与明确动作文本。
2. **不可导出状态：PASS。** `needs_review`、带 `stale_at` 的 accepted memo、`legal_research_memo` 依据不足记录均保留状态和恢复信息，但没有导出按钮。
3. **导出中：PASS。** POST 等待期间按钮禁用，Download icon 替换为旋转 Loader，文本缩短为“正在导出”；列表和周边布局不移动。
4. **Fail-closed：PASS。** HTTP 409 的后端 `detail` 原文显示在当前 memo 行内并使用 `role=alert`；按钮恢复可用，其他 memo 行不被移除或重置。
5. **成功下载：PASS。** 第二次调用严格命中研究备忘录 POST 与 download 端点，浏览器收到 `.docx` download；当前行以 `role=status` 显示“备忘录 v1 已导出并下载”。
6. **响应式与视觉一致性：PASS。** 1440 下沿用三列表格；393 CSS px 下保留标题和状态两列，将操作自然换到下一行。无横向滚动、裁切、重叠、渐变、玻璃、pill 或装饰卡片。

## 截图证据

| 证据 | 结果 | 主审记录 |
|---|---|---|
| `docs/screenshots/ui-audit-2026-07-13-research-memo-docx/01-export-loading-desktop-1440.png` | PASS | 1440 × 1000；按钮 loading 状态紧凑，表格列宽稳定。 |
| `docs/screenshots/ui-audit-2026-07-13-research-memo-docx/02-export-fail-closed-desktop-1440.png` | PASS | 后端错误紧贴当前 memo；列表、状态和第 5 阶段均保留。 |
| `docs/screenshots/ui-audit-2026-07-13-research-memo-docx/03-export-success-desktop-1440.png` | PASS | 成功提示与导出按钮同一行上下文内可见，层级克制。 |
| `docs/screenshots/ui-audit-2026-07-13-research-memo-docx/01-export-loading-narrow-393.png` | PASS | 393 CSS px；操作换行后完整可见，状态列未被挤压。 |
| `docs/screenshots/ui-audit-2026-07-13-research-memo-docx/02-export-fail-closed-narrow-393.png` | PASS | 英文后端错误自然换行，未越界或遮挡按钮。 |
| `docs/screenshots/ui-audit-2026-07-13-research-memo-docx/03-export-success-narrow-393.png` | PASS | 成功提示、按钮和后续法律意见书阶段顺序清楚，无横向溢出。 |

窄窗 PNG 为 393 CSS px 的设备像素输出（1081 × 1999）。首轮两张 fail-closed 截图出现 Chromium 合成层黑块，已拒绝；加入双 `requestAnimationFrame` 与稳定等待后重采集，表中路径均为逐张检查后的接受版本。

## 可访问性

- 导出按钮同时提供 Lucide Download icon 和可读文本；进行中按钮禁用并保留明确状态文本。
- 失败使用 `role=alert`，成功使用 `role=status`，状态变化位于触发动作所属 memo 行。
- Playwright 断言按钮可见性、禁用状态、响应反馈和 reflow；截图不能证明完整键盘顺序、读屏器播报或 WCAG 合规，未作此类声明。

## 验证结果

- `cd frontend && npm run lint`：PASS
- `cd frontend && npx tsc --noEmit`：PASS
- `cd frontend && npm run build`：PASS
- `cd frontend && npx playwright test tests/vera-legal-research.spec.ts --config=playwright.config.ts --grep "exports only an accepted current memo"`：PASS，desktop 1440 与 mobile 393 共 2/2；截图稳定化后复跑仍为 2/2
- `git diff --check`：PASS

focused Playwright 断言研究 memo 专用 POST/download URL、成功 download、409 `detail` 原文、失败后列表保留、三类不可导出记录无入口，以及 document/第 4 阶段横向溢出均不超过 1px。

## 限制

- Playwright 使用真实构建后的前端和本地后端 matter 环境，但为稳定覆盖资格矩阵与失败分支，拦截了 matter 投影及研究 memo export/download 响应；该测试不替代后端资格、审计链或 DOCX 内容测试。
- 本轮没有解包检查下载的 DOCX 版式、字段或哈希，只验证前端专用端点、响应处理和浏览器下载行为。
- 本轮未修改后端、`docs/status`、导航、其他页面或既有法律研究流程。
