# VividAI Firefly GPT Image 2 接入说明

本文档用于说明如何接入 `https://3711api.top` 渠道的 `firefly-gpt-image-2` 模型，并分别调用文生图和图生图能力。

结论先行：

- 文生图使用 `/v1/images/generations`。
- 图生图使用 `/v1/images/edits`，必须走 `multipart/form-data` 上传参考图。
- 不建议用 `/v1/images/generations` 做图生图；即使接口返回成功，参考图也可能被忽略。
- `firefly-gpt-image-2` 的尺寸控制整体可用，但建议按比例和档位配置显式像素映射。

## 基础信息

| 项目 | 值 |
| --- | --- |
| Base URL | `https://3711api.top` |
| OpenAI SDK Base URL | `https://3711api.top/v1` |
| 模型 ID | `firefly-gpt-image-2` |
| 鉴权方式 | `Authorization: Bearer YOUR_VIVIDAI_API_KEY` |
| 文生图接口 | `POST /v1/images/generations` |
| 图生图接口 | `POST /v1/images/edits` |

## 文生图

### HTTP 请求

```http
POST https://3711api.top/v1/images/generations
Authorization: Bearer YOUR_VIVIDAI_API_KEY
Content-Type: application/json
```

### 请求参数

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 固定填 `firefly-gpt-image-2` |
| `prompt` | string | 是 | 图片描述 |
| `size` | string | 否 | 建议填显式像素值，例如 `1024x1024`、`2560x1440`、`3840x2160` |
| `response_format` | string | 否 | 建议填 `url` |

### Curl 示例

```bash
curl https://3711api.top/v1/images/generations \
  -H "Authorization: Bearer YOUR_VIVIDAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "firefly-gpt-image-2",
    "prompt": "A clean 4K 16:9 futuristic product poster with simple geometric shapes",
    "size": "3840x2160",
    "response_format": "url"
  }'
```

### Python 示例

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_VIVIDAI_API_KEY",
    base_url="https://3711api.top/v1",
)

response = client.images.generate(
    model="firefly-gpt-image-2",
    prompt="A clean 4K 16:9 futuristic product poster with simple geometric shapes",
    size="3840x2160",
    response_format="url",
)

print(response.data[0].url)
```

### 响应示例

```json
{
  "created": 1786949607,
  "data": [
    {
      "url": "https://example.com/generated-image.png"
    }
  ]
}
```

## 图生图

图生图必须使用 `/v1/images/edits`，并用 `multipart/form-data` 上传图片文件。

### HTTP 请求

```http
POST https://3711api.top/v1/images/edits
Authorization: Bearer YOUR_VIVIDAI_API_KEY
Content-Type: multipart/form-data
```

### 请求参数

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 固定填 `firefly-gpt-image-2` |
| `prompt` | string | 是 | 编辑或重绘说明 |
| `image` | file | 是 | 参考图文件 |
| `size` | string | 否 | 建议填显式像素值，例如 `1024x1024`、`2560x1440` |

### Curl 示例

```bash
curl https://3711api.top/v1/images/edits \
  -H "Authorization: Bearer YOUR_VIVIDAI_API_KEY" \
  -F "model=firefly-gpt-image-2" \
  -F "prompt=Use the uploaded image as the exact reference. Preserve the main composition and turn it into a polished product poster." \
  -F "size=1024x1024" \
  -F "image=@input.png"
```

### Python 示例

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_VIVIDAI_API_KEY",
    base_url="https://3711api.top/v1",
)

with open("input.png", "rb") as image:
    response = client.images.edit(
        model="firefly-gpt-image-2",
        image=image,
        prompt="Use the uploaded image as the exact reference. Preserve the main composition and turn it into a polished product poster.",
        size="1024x1024",
    )

print(response.data[0].url)
```

### 图生图提示词建议

为了提高参考图关联度，提示词中建议明确要求模型使用参考图：

- 保留主体、构图、姿态或界面布局。
- 描述需要改变的风格或细节。
- 明确不要生成无关场景。

示例：

```text
Use the uploaded image as the exact reference. Preserve the main subject, composition, pose, and layout. Change only the visual style to a cinematic cyberpunk poster. Do not create an unrelated scene.
```

## 尺寸建议

`firefly-gpt-image-2` 支持多档尺寸。实际接入时建议把“比例 + 档位”映射成明确像素值。

| 档位 | 1:1 | 16:9 | 9:16 | 4:3 | 3:4 |
| --- | --- | --- | --- | --- | --- |
| 1K | `1024x1024` | `1280x720` | `720x1280` | `1024x768` | `768x1024` |
| 2K | `2048x2048` | `2560x1440` | `1440x2560` | `2048x1536` | `1536x2048` |
| 4K | `3840x3840` | `3840x2160` | `2160x3840` | `4096x3072` | `3072x4096` |

实测表现：

- `1024x1024` 可以稳定输出 `1024x1024`。
- `2048x2048` 可以稳定输出 `2048x2048`。
- `2560x1440` 可以稳定输出 `2560x1440`。
- `3840x2160` 可以稳定输出 `3840x2160`。
- `4:3` 部分尺寸可能被上游映射到相近尺寸，例如请求 `2048x1536` 时可能得到 `2304x1728`。

## SanHub 后台配置建议

建议拆成两个渠道或至少两个模型：文生图和图生图分开配置，避免图生图误走 `/v1/images/generations`。

### 文生图模型

渠道配置：

| 字段 | 填写 |
| --- | --- |
| 渠道类型 | `OpenAI Images` |
| Base URL | `https://3711api.top` |
| API Key | `YOUR_VIVIDAI_API_KEY` |

模型配置：

| 字段 | 填写 |
| --- | --- |
| 模型名称 | `VividAI Firefly GPT Image 2` |
| 模型 ID | `firefly-gpt-image-2` |
| 文生图 | 开启 |
| 图生图 | 关闭 |
| 多图参考 | 关闭 |
| 分辨率选择 | 开启 |
| 要求参考图 | 关闭 |

### 图生图模型

渠道配置：

| 字段 | 填写 |
| --- | --- |
| 渠道类型 | `OpenAI Edits` |
| Base URL | `https://3711api.top` |
| API Key | `YOUR_VIVIDAI_API_KEY` |

模型配置：

| 字段 | 填写 |
| --- | --- |
| 模型名称 | `VividAI Firefly GPT Image 2 Edit` |
| 模型 ID | `firefly-gpt-image-2` |
| 文生图 | 关闭 |
| 图生图 | 开启 |
| 多图参考 | 开启 |
| 分辨率选择 | 开启 |
| 要求参考图 | 开启 |

### 分辨率配置

SanHub 后台如果选择“高清多档”预设，可以作为起点，但需要手动替换默认分辨率表。

推荐填写：

```json
{
  "1K": {
    "1:1": "1024x1024",
    "16:9": "1280x720",
    "9:16": "720x1280",
    "4:3": "1024x768",
    "3:4": "768x1024"
  },
  "2K": {
    "1:1": "2048x2048",
    "16:9": "2560x1440",
    "9:16": "1440x2560",
    "4:3": "2048x1536",
    "3:4": "1536x2048"
  },
  "4K": {
    "1:1": "3840x3840",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "4:3": "4096x3072",
    "3:4": "3072x4096"
  }
}
```

## 常见问题

### 图生图返回结果和参考图无关

优先检查：

- 是否使用了 `OpenAI Edits` 渠道。
- 请求是否为 `multipart/form-data`。
- 是否上传了 `image` 文件字段。
- 模型 ID 是否为 `firefly-gpt-image-2`。
- 后台模型是否开启了图生图能力。
- 是否误选了文生图模型。

不要用 `OpenAI Images` 渠道测试图生图。该路径可能返回成功，但参考图可能没有被实际使用。

### 尺寸没有按预期生效

优先检查：

- 后台是否开启了“分辨率选择”。
- 是否为每个档位和比例填写了显式像素值。
- 是否只用了“高清多档”预设但没有替换默认表。

### 返回的是临时链接

VividAI 返回的图片 URL 可能是上游临时链接。业务系统应尽快下载或转存到自己的对象存储。

### 是否应该使用 `response_format=b64_json`

建议使用 `response_format=url`。如果调用方强依赖 base64，需要在业务侧下载 URL 后自行转换。
