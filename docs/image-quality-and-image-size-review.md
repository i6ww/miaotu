# 图片画质 / imageSize 评审与变更记录

> 日期: 2026-09-22
> 范围: image-quality feature（admin 勾选 / 用户端控件 / 服务端转发）以及单页 `imageSize` 收敛
> 状态: 本地未提交 GitHub，所有内容停留在工作区，等待用户验收后再决定如何 commit

## 一、本次会话梳理的 6 个问题

| # | 问题 | 状态 |
| --- | --- | --- |
| 1 | DB 中 `qualityOptions` 字段实际只有预设值（`NULL` 或 `['low','medium','high']`），缺少 admin 自由配置入口 | 排查完毕 |
| 2 | `types/index.ts` 中 `qualityOptions` 注释与三处实现判据不一致 | 已修复 |
| 3 | 批量页 `onFailed` / `onTimeout` 在 `payload` 为空时把已 `processing` 的任务拖回 `pending`（stale closure） | 已修复 |
| 4 | admin 画质勾选 "取消全部 → 状态变 `[]` 但 UI 仍显示全选" | 已修复 |
| 5 | `gemini` 渠道是否漏报支持 quality（涉及 admin UI 与 `supportsQualityControl` 判据是否对齐） | 待定，未修复 |
| 6 | 单页 `imageSize` 不做档位收敛：state 可能落在 `currentModel.imageSizes` 之外，导致提交静默错配 | 待定，未修复 |

## 二、代码改动清单

### 2.1 新增 `lib/image-quality.ts`（共 76 行）

**目的**：把原本散落在两个页面里的"质量档位"硬编码与判据集中到一处，让 admin 勾选、用户端 picker、服务端 `quality` 字段解析共用同一份事实表。

**关键导出**：

- `IMAGE_QUALITY_OPTIONS: ImageQualityOption[]` — 值域 `['low','medium','high']`，label 用 Unicode 转义防止源文件出现中文字符
- `DEFAULT_IMAGE_QUALITY = 'medium'`
- `supportsQualityControl(model)` — 仅在 `openai-compatible` / `openai-edits` + `apiModel` 含 `gpt-image-2` 时返回 `true`；其他渠道转发但被静默丢弃，不会暴露该控件
- `getQualityOptions(model)` — 返回 picker 要展示的选项数组；空集表示该模型不能使用 quality
- `resolveImageQuality(model, preferred)` — 把用户偏好收敛为合法值；UI 渲染和提交共用同一条路径，杜绝"显示一个、上送另一个"

**判据副本提醒**：admin 勾选区域的 `gpt-image-2` 字面量判定（`app/admin/image-channels/page.tsx:1692`）与 `QUALITY_AWARE_API_MODEL` 是相同事实的两处副本。两者必须保持同步；新增 `gpt-image-3` 时需同时改两处。

### 2.2 `types/index.ts` 修改

修改 `ImageModelFeatures.qualityOptions` 注释：

```208:types/index.ts
  qualityOptions?: string[]; // quality options (low/medium/high); empty array or undefined means all enabled
```

原注释 `"为空或 undefined 表示不显示"` 与 admin 页面 + `getQualityOptions` 的实现语义不一致（实现是"全部启用"）。注释改为与实现一致，并明确列出合法值集合。

### 2.3 `components/generator/image-generation-page.tsx` 修改

**import**（line 43）：

```43:components/generator/image-generation-page.tsx
import { DEFAULT_IMAGE_QUALITY, getQualityOptions, resolveImageQuality } from '@/lib/image-quality';
```

**quality state 初始化**（line 128）：

```128:components/generator/image-generation-page.tsx
  const [quality, setQuality] = useState<string>(DEFAULT_IMAGE_QUALITY);
```

原本硬编码 `'medium'`，改为使用共享常量，避免日后调整默认值得改多处。

### 2.4 `components/generator/batch-image-generation-page.tsx` 修改

**`updateTask` 工具函数**（lines 237-244）：

```237:components/generator/batch-image-generation-page.tsx
      setTasks((current) =>
        current.map((task) =>
          task.id === taskId
            ? { ...task, ...(typeof patch === 'function' ? patch(task) : patch) }
            : task
        )
      );
```

原本 `updateTask(taskId, patch)` 直接用闭包里的旧 `task`，导致 stale closure。改为同时支持 `function updater`，调用方传入 `(current) => ({...})` 读取最新状态。

**`onFailed` 处理空 payload**（lines 526-538）：

```526:components/generator/batch-image-generation-page.tsx
          onFailed: async (message: string, payload) => {
            if (!payload) {
              // `task` is a snapshot taken at submit time, so its status is stale
              // here; read the live status to avoid dragging an already-advanced
              // task back to 'pending'.
              updateTask(task.id, (current) => ({
                status: current.status === 'processing' ? 'processing' : 'pending',
                error: message,
              }));
              return;
            }

            updateTask(task.id, { status: 'failed', error: message, progress: 0 });
          },
```

原本 `status: 'pending'` 直接覆盖——若提交瞬间状态已变为 `processing`（如其他 tab 已开始轮询），错误回调会把进度倒退。修复为读取 live status，`processing` 时保持 `processing`。

**`onTimeout`**（lines 540-545）：采用相同的 live-status 读法。

### 2.5 `app/admin/image-channels/page.tsx` 修改（画质编辑模型）

**新增 `QUALITY_OPTION_VALUES` 常量**（lines 33-36）：

```33:app/admin/image-channels/page.tsx
// Quality options offered to users, in display order (high -> low). The values
// must match IMAGE_QUALITY_OPTIONS in lib/image-quality.ts; the order here only
// affects how the checkboxes are presented.
const QUALITY_OPTION_VALUES = ['high', 'medium', 'low'] as const;
```

消除 `['high','medium','low']` 字面量在同一文件中重复两次（1691 / 1703），避免日后调整档位需要手工同步两处。

**勾选逻辑重写**（lines 1696-1733）：

```1696:app/admin/image-channels/page.tsx
                  {QUALITY_OPTION_VALUES.map((q) => {
                    const options = modelForm.features.qualityOptions;
                    // An empty or undefined list means "all options enabled", so
                    // normalize it to an explicit list before comparing.
                    const enabled: string[] =
                      options && options.length > 0 ? options : [...QUALITY_OPTION_VALUES];
                    const checked = enabled.includes(q);
                    // Persisting an empty list would read back as "all enabled" and
                    // silently re-check every box, so the last checked option cannot
                    // be turned off.
                    const isLastChecked = checked && enabled.length === 1;
```

- 用 `enabled` 归一化列表替代原先 `!options || options.length === 0 || options.includes(q)` 的三元判据，**消除 "state 为 `[]` 但显示全选" 的自相矛盾**
- 最后一档置为 `disabled` 并附 `title="至少保留一个画质选项"`，从源头杜绝 UI 不一致
- `onChange` 简化为 `next = e.target.checked ? [...enabled, q] : enabled.filter(...)`，不再产出 `[]`

**提示文案**（line 1735）：

```
取消勾选即隐藏对应画质选项（至少保留一项）
```

补充"至少保留一项"约束说明。

### 2.6 `lib/image-quality.ts` 新增导出 `isQualityAwareModelName`

为 admin "生成记录" 页（2.7）复用，新增模块级助手：

```84:lib/image-quality.ts
export function isQualityAwareModelName(model: string | undefined): boolean {
  if (!model) return false;
  return model.toLowerCase().includes(QUALITY_AWARE_API_MODEL);
}
```

仅复刻 `supportsQualityControl` 的"模型名"那一条判据（`channelType` 那条需要完整 `SafeImageModel`），用于**只拿到模型名字串**的读路径（admin 历史、审计日志等）。`QUALITY_AWARE_API_MODEL` 仍是模块私有常量。

### 2.7 `app/admin/generations/page.tsx` 新增「类型」列展示质量

**目的**：admin "生成记录" 表的「类型」列对 `gemini-image` 记录（包含 `openai-compatible` / `openai-edits` 渠道生成的 gpt-image-2 图像，见 `app/api/generate/image/route.ts:37-42` 的 `IMAGE_TYPE_BY_CHANNEL` 映射）追加显示质量档位（低/中/高）。

**改动**：

- **新增 import**（line 8）：
  ```8:app/admin/generations/page.tsx
  import { IMAGE_QUALITY_OPTIONS, isQualityAwareModelName } from '@/lib/image-quality';
  ```
- **新增 `qualityLabel` 助手**（line 132-135）：
  ```132:app/admin/generations/page.tsx
  function qualityLabel(quality: string): string {
    const match = IMAGE_QUALITY_OPTIONS.find((option) => option.value === quality);
    return match?.label ?? quality;
  }
  ```
  label 复用 `IMAGE_QUALITY_OPTIONS`（用户端 picker 的同一份事实表），admin 与用户看到的字面值保持一致。
- **`getResolutionDetail` 末尾追加**（line 152-154）：
  ```152:app/admin/generations/page.tsx
    if (params.quality && isQualityAwareModelName(params.model)) {
      parts.push(qualityLabel(params.quality));
    }
  ```

**判据解释**：`params.quality` 仅在 `resolveImageQuality` 通过全链路判据（渠道类型 + 模型名）后才写入；非空即隐含"模型是 quality-aware 的"。再叠加 `isQualityAwareModelName(params.model)` 是 belt-and-suspenders，防御未来非标写入路径。

**效果**：原 detail `1K 16:9` → 新 detail `1K 16:9 中`。只有当 `record.type === 'gemini-image' | 'zimage-image' | 'gitee-image'` 且 `modelLabel` 命中时才会展示，因此 GPT 之外的 sora-video 等类型不受影响。

## 三、未修复的问题

### 3.1 #5 — `gemini` 渠道能力漏报（待澄清）

**现状**：`lib/image-quality.ts:41-47` 的 `supportsQualityControl` 仅放行 `openai-compatible` / `openai-edits` + `gpt-image-2`。`gemini` 渠道**不会**暴露 quality 控件。这是有意为之（`gemini` 渠道代码路径不转发 `quality` 字段，暴露会承诺一个实际被静默丢弃的设定）。

**待澄清点**：admin 是否曾把 `gemini` 模型也配置过 `qualityOptions`？如果 DB 里出现 `gemini` + 非空 `qualityOptions` 数据（本次审计未发现），要么 UI 不暴露但数据残留、要么 admin 曾误以为可以配置——这是**产品需求**问题，不是 bug。需要确认：

- 是否计划让某个 Gemini 模型也支持 quality？若是，需新增 `image-generator.ts` 路径支持透传，并同步更新 `QUALITY_AWARE_CHANNEL_TYPES`
- 若否，需要决定如何处理已存在的脏数据（清理 / 标记 / 忽略）

**建议**：在 admin 侧把"画质选项"勾选区域也用 `supportsQualityControl` gate 一下（不仅仅是 `apiModel.toLowerCase().includes('gpt-image-2')`），让两端判据统一。

### 3.2 #6 — 单页 `imageSize` 不做档位收敛（待修复）

**完整描述**（对话上一条回复已详述）：

- **一句话结论**：单页把 `imageSize` 当"用户 UI 状态"管，下拉框根据当前模型重算，但 state 只跟 `model.id` 变化走一次重置——切档位、admin 中途改模型、特性位翻转等都不会触发重置。批量页每条任务提交前都过 `resolveTaskImageSize` 收敛；单页只在特性开关与档位列表上做 submit-time ternary，导致 state 可能落在新档位列表之外，提交时**原样发出**，服务端 `resolutions[imageSize]` 查不到 → **静默回落到默认分辨率**，用户付了 4K 拿到 2K 都没错可看。
- **三条失守路径**：admin 中途改档位 / admin 切换模型且新模型缺 `defaultImageSize` / 初始挂载竞态
- **关键架构差异**：批量页用 `resolveTaskImageSize` 做 submit-time 收敛 + 完整回退链；单页两者皆缺
- **服务端为什么"静默错配"**：`v1-images.ts:269` 的 `imageSize: firstString(...)` 只取字符串、无数组白名单；`image-generator.ts:478-494` 的 `resolveImageTarget` 缺值时直接 `applyValue` 不调用，让 `resolvedSize` 留空，下游走 default

**修复方向**：

| 方案 | 修什么 | 风险 |
| --- | --- | --- |
| (A) submit-time 收敛：把批量页的 `resolveTaskImageSize` 提到 `lib/image-generator.ts` 或 `lib/image-quality.ts`，单页提交处调用 | 仅 submit 路径 | 极小 |
| (B) state 收敛：把当前 `appliedModelRef` 渲染期 reset 改成依赖 `[currentModel.id, currentModel.imageSizes, currentModel.features.imageSize, currentModel.defaultImageSize]` 的 `useEffect` | UI 状态 | 极小 |
| (C) 服务端白名单：`v1-images.ts` + `/api/image-models` 校验 `imageSize` 是否在 `model.imageSizes` 中 | 服务端 | 中（API 契约变化） |

**推荐组合**：**(A) + (B)**——与本次"状态收敛"主线一致，复用已有收敛模式。(C) 是后续独立工作。

## 四、测试计划

### A. 已修复项的手动步骤

| Bug | 验证步骤 | 期望 |
| --- | --- | --- |
| #3 | 打开批量页 → 提交任务 → 在生成完成前故意制造错误（例如关闭 tab / 切换网络观察 `onFailed` / `onTimeout`） | `processing` 任务保持 `processing`，不被错误回调覆盖；任务最终稳定到 `failed` 或 `completed` 而不是来回飘 |
| #4 | `/admin/image-channels` → 编辑一个 `apiModel` 含 `gpt-image-2` 的模型 → 依次取消"高""中" | 第三次取消"低"应**不可点**（灰化 + hover 提示"至少保留一个画质选项"）；保存 → 重新进入 → 勾选态与保存值一致（不再回弹） |
| #1 / #2 | 现有未配置 `qualityOptions` 的模型仍能正常生成（不报错、不消失） | 行为不变 |
| 单页接线 | 选一个 `gpt-image-2` 模型 → 出现 quality picker → 选 high → 生成 → 历史记录显示提交参数含 `quality=high` | UI 与请求一致 |

### B. 未修复项的人工复现（用于决定优先级）

| Bug | 复现步骤 | 观察 |
| --- | --- | --- |
| #6 (A 路径) | 用户选 `imageSize='4K'` → admin 在另一处把该模型的 `imageSizes` 改为 `['1K','2K']` 并保存 → 用户刷新页面 | 下拉只剩 `['1K','2K']` 但 state 残留 `'4K'`；CustomSelect 显示 vs 实际值不一致；提交可能把 `'4K'` 原样发出 |
| #6 (B 路径) | admin 保存模型时 `defaultImageSize` 留空（或被改成不在 `imageSizes` 中的值）→ 用户切到该模型 | state 残留上一个模型的值或初始 `'1K'`；下拉不显示旧值；提交透传 stale 值 |
| #5 | admin 端给一个 Gemini 模型配置 `qualityOptions` 并保存 | 重新进入编辑 → UI 不显示画质勾选区域（应与现状一致），但 DB 数据残留 |

### C. 自动化测试

仓库当前未配置单测框架（`package.json` 内未见 `vitest` / `jest` 依赖）。如要补，建议从 `lib/image-quality.ts` 开始（纯函数，零外部依赖）：

- `getQualityOptions` 在 `qualityOptions=[undefined, [], ['high'], 'low']` 下的输出
- `resolveImageQuality` 在 preferred 值不在 options 中时回退到第一个
- `supportsQualityControl` 在各类 `channelType` 下的判定

## 五、暂未提交 GitHub 的说明

当前 `git status` 大致如下（以实际为准）：

```
modified:   components/generator/batch-image-generation-page.tsx
modified:   components/generator/image-generation-page.tsx
modified:   types/index.ts
modified:   app/admin/image-channels/page.tsx          ← bug #4 修复
modified:   app/admin/generations/page.tsx             ← 类型列展示质量

Untracked files:
  api-integration-guide(36).md                  ← 会话前既存
  lib/image-quality.ts                         ← 本会话新增
  docs/image-quality-and-image-size-review.md    ← 本文档
```

未执行 `git add` / `git commit`。等用户完成验收测试后再决定如何 commit。**建议按语义拆 2-3 个 commit**：

1. bug #3 修复（批量页 stale closure）
2. quality feature 整合（新模块 + #2 注释对齐 + #4 admin 修复 + 单页接线）
3. 文档（`docs/image-quality-and-image-size-review.md`）

可选第 4 个 commit：`lib/image-quality.ts` 单独抽出来作为"共享模块"前置，方便 review。