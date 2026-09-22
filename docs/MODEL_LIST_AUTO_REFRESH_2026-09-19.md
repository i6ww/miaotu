# 模型列表自动刷新 —— 实现说明与回归修复

> 记录时间：2026-09-19
> 相关提交：`22b1922`（已推送），以及本文第三节所述修复（**当前仅存在于本地工作区，尚未提交**）

---

## 一、背景

**问题**：管理员在后台开关渠道/模型后，已经打开页面的用户看不到变化，必须手动刷新浏览器才能拿到新模型列表。原因是模型列表只在页面挂载时拉取一次，之后一直存在 React state 里，再无重新拉取的时机。

**先确认服务端不是瓶颈**：三个模型接口本身就是实时的，没有缓存层。

| 接口 | 实现 | 是否缓存 |
|---|---|---|
| `GET /api/chat/models` | 直接 `getChatModels(true)` 查库 | 无 |
| `GET /api/image-models` | `export const dynamic = 'force-dynamic'` + 查库 | 无 |
| `GET /api/video-models` | 同上 | 无 |

`lib/cache.ts` 里的 `withCache` / `CacheTTL.CHAT_MODELS` 机制，这三个接口**根本没有用到**，所以不需要在服务端做缓存失效。

因此本轮采用**纯前端方案，服务端零改动**。

---

## 二、实现（提交 `22b1922`）

聊天页、图片页、视频页三个页面统一加了两条刷新触发线，以图片页为例（`components/generator/image-generation-page.tsx`）：

```js
useEffect(() => {
  if (!isActive) return;                       // 非活跃 Tab 完全不发请求

  const refreshModels = async (isInitial: boolean) => {
    try {
      const res = await fetch('/api/image-models', { cache: 'no-store' });
      const data = await res.json();
      const models = data.data?.models || [];
      modelsCacheRef.current = models;
      setAvailableModels(models);

      setSelectedModelId((prev) => {           // 选中模型失效 → 自动回落
        if (prev && models.some((m) => m.id === prev)) return prev;
        return models[0].id;
      });
    } catch (err) {
      if (isInitial) console.error('Failed to load models:', err);   // 刷新失败保留旧列表
    } finally {
      if (isInitial) setModelsLoaded(true);
    }
  };

  if (!modelsLoaded) void refreshModels(true);                     // 首次加载

  document.addEventListener('visibilitychange', handleVisibility); // 触发线 1：切回标签页
  const timer = setInterval(() => {                                // 触发线 2：60 秒兜底轮询
    if (!document.hidden) void refreshModels(false);
  }, 60000);

  return () => {
    document.removeEventListener('visibilitychange', handleVisibility);
    clearInterval(timer);
  };
}, [isActive, modelsLoaded]);
```

### 设计要点

1. **双触发时机**
   - `visibilitychange`：浏览器标签从后台切回前台时立即刷新。管理员改完配置，用户切一下标签就能看到。
   - `setInterval` 60 秒：用户一直盯着页面不动时的兜底。带 `document.hidden` 判断，**后台标签页不发请求**，不浪费资源。

2. **`isInitial` 区分首载与静默刷新**
   - 首载：显示 loading、失败时提示（聊天页弹 toast，图片/视频页打 `console.error`）。
   - 后续刷新：完全静默，**失败就保留旧列表**，不弹窗不刷日志。渠道临时抖动不会让用户看到报错。

3. **选中模型失效自动回落**
   选中模型仍在列表中 → 保持不动；已被下线 → 回落到列表第一个。若不处理，用户提交时才会发现模型不存在。

4. **`modelsCacheRef` 内存缓存**
   图片页 / 视频页在首载时优先使用 ref 中已有的列表，避免同一会话内重复请求。

### 三个页面的差异

| 页面 | useEffect 依赖 | 特点 |
|---|---|---|
| `components/chat/chat-page.tsx` | `[activeSession?.modelId]` | 无内存缓存；切换会话时 effect 重建，且每次都按「首载」处理（会显示 loading） |
| `components/generator/image-generation-page.tsx` | `[isActive, modelsLoaded]` | 有 `modelsCacheRef` |
| `components/generator/video-generation-page.tsx` | `[isActive, modelsLoaded]` | 有 `modelsCacheRef`，并同步比例/时长参数 |

---

## 三、上线后发现的回归问题与修复（本地未提交）

### 问题 1：用户手动选的比例、分辨率、时长被重置回默认值

**现象**：用户切一下标签再回来，模型更新确实立即生效了，但自己选好的分辨率和比例也变成了默认值，等于每次都要重选一遍。

**根因**：页面里原本就有一个「切换模型时把参数重置为新模型默认值」的 effect，它的依赖数组里包含 `availableModels`：

```js
useEffect(() => {
  const model = availableModels.find((item) => item.id === selectedModelId);
  if (!model) return;

  setAspectRatio(model.defaultAspectRatio);        // ← 无条件重置
  if (model.defaultImageSize) setImageSize(model.defaultImageSize);
  ...
}, [availableModels, clearImages, onClearExternalReference, selectedModelId]);
```

刷新时 `setAvailableModels(models)` 传入的是 `JSON.parse` 出来的**全新数组和全新对象引用**。React 逐项比较依赖时判定「变了」，effect 重新执行，于是被误判成「模型切换了」，无条件把参数重置。

**触发链路**：轮询/切标签刷新 → `setAvailableModels(新引用)` → effect 依赖变化 → 误认为模型切换 → 重置参数。

改动前 `availableModels` 只在挂载时赋值一次，这个 effect 仅在用户真的换模型时触发，行为是正确的；新增轮询与切标签刷新后，**每 60 秒和每次切标签都会误触发一次**。

**修复**：用 `useRef` 记录「已经套用过默认参数的模型 id」，只有 id 真的变化才重置：

```js
// appliedModelRef records the model whose defaults were already applied.
// availableModels is a brand-new array (and new model objects) after every
// poll / tab-focus refresh, so it must not be used to detect a model switch.
const appliedModelRef = useRef<string>('');

useEffect(() => {
  const model = availableModels.find((item) => item.id === selectedModelId);
  if (!model) return;

  if (appliedModelRef.current !== model.id) {      // ← 判断依据换成模型 id
    appliedModelRef.current = model.id;
    setAspectRatio(model.defaultAspectRatio);
    if (model.defaultImageSize) setImageSize(model.defaultImageSize);
  }
  ...
}, [availableModels, ...]);
```

依赖数组中的 `availableModels` 保留（能力校验仍然需要它），但不再作为「模型是否切换」的判断依据。

同时给能力校验类副作用加了空值判断，避免每 60 秒空转写状态：

```js
if (!model.features.imageToImage) {
  if (images.length > 0) clearImages();
  if (externalReference) onClearExternalReference?.();
}
```

### 问题 2：视频页的自动刷新其实从未生效

`components/generator/video-generation-page.tsx` 的刷新 effect 开头写的是：

```js
if (!isActive || modelsLoaded) {
  return;
}
```

执行顺序：

1. 首次进入，`modelsLoaded=false` → 注册 `visibilitychange` 监听 + 60 秒定时器；
2. `refreshModels(true)` 完成后 `setModelsLoaded(true)`；
3. 依赖数组 `[isActive, modelsLoaded]` 变化 → React 先执行 cleanup，**把刚注册的监听器和定时器全部拆掉**；
4. effect 重跑，此时 `modelsLoaded` 已是 `true` → 直接 `return`，监听器再也没装回来。

结果：视频页只有挂载那一次拉取，切标签不刷新、轮询也不执行。已改为与图片页一致：

```js
if (!isActive) return;
...
if (!modelsLoaded) {          // 加载只做一次，监听器始终注册
  void refreshModels(true);
}
```

### 问题 3（连带）：用户上传的参考素材被误清空

视频页的模型变更 effect 里有这些清理动作：

```js
if (!model.features.imageToVideo && files.length > 0) clearFiles();                              // 清空已上传的参考图/参考视频
if (!model.features.imageToVideo && activeExternalReference) setActiveExternalReference(null);   // 清掉「再次生成」带过来的参考
if (model.channelType !== 'minimax-h3') { setReferenceVideoUrlsText(''); setReferenceAudioUrlsText(''); }  // 清掉参考 URL
```

因为同一个「数组换引用」的误触发，这些动作会在每次刷新时执行——用户上传参考图后切个标签回来，素材就没了。`appliedModelRef` 的引入让这些清理只在**真正换模型（能力确实变化）**时执行。

图片页的 `clearImages()` / `onClearExternalReference()` 同理，属于同一个误触发源。

### 问题 4（顺带清理）：setState updater 里写副作用

图片页和视频页的模型回落逻辑原本写成：

```js
setSelectedModelId((prev) => {
  if (prev && models.some((m) => m.id === prev)) return prev;
  setAspectRatio(models[0].defaultAspectRatio);   // ← 在 updater 内部调用 setState
  setDuration(models[0].defaultDuration);
  return models[0].id;
});
```

updater 应当是纯函数，React 18 严格模式下会被调用两次，其中的副作用也会执行两次。已改为只返回新 id，默认参数统一由模型变更 effect 按模型 id 应用。

> 同样的写法在 `components/generator/batch-image-generation-page.tsx:213-238`（`loadModels`）里仍然存在。但那段只在「当前模型已被下线」的回落分支执行、且写入的值相同，幂等无副作用，本次未改动。

---

## 四、改动文件汇总

| 文件 | 改动内容 | 提交状态 |
|---|---|---|
| `components/chat/chat-page.tsx` | 自动刷新（双触发线 + 失效回落） | 已提交 `22b1922` |
| `components/generator/image-generation-page.tsx` | 自动刷新 + 参数重置修复 + updater 纯函数化 | 修复部分**未提交** |
| `components/generator/video-generation-page.tsx` | 自动刷新 + 参数重置修复 + 监听器注册修复 + updater 纯函数化 | 修复部分**未提交** |
| `components/generator/batch-image-generation-page.tsx` | 已核对，无同类无条件重置问题 | 未改动 |

---

## 五、验证要点

1. 图片页选一个非默认比例（如 4:3）和分辨率 → 切到别的浏览器标签再切回来 → 比例/分辨率**应保持不变**
2. 停留在页面超过 60 秒（触发一次轮询）→ 参数同样不应变化
3. 视频页选好比例/时长、上传参考图 → 切标签回来 → 参数与素材都应保留
4. 管理后台关闭当前正在使用的模型 → 用户侧切回标签页 → 模型自动回落到可用模型，**此时**参数才应变为新模型的默认值
5. 打开浏览器 Network 面板，确认视频页每 60 秒确实发出 `/api/video-models` 请求（修复前不会发）

---

## 六、方案边界与取舍

- 这是**降低延迟**，不是**实时推送**：最坏情况延迟 60 秒（用户一直盯着页面不动、也不切标签）。
- 若要求「管理员一改开关，所有在线用户秒级同步」，需要换方案：SSE / WebSocket 推送，或把轮询间隔降到 5-10 秒。当前 60 秒是请求量与及时性的折中——按「在线人数 × 每分钟 1 次」估算，服务器压力很小。
- **已知取舍**：管理员修改某模型的默认比例后，已打开的页面不会主动跟随（用户下次换模型或刷新页面才生效）。这是为了让刷新不打断用户已经做好的选择。
