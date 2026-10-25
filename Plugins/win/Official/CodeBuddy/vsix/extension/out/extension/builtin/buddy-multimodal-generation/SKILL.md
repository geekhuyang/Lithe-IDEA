---
name: 多模态内容生成
description: >
  多模态内容生成能力，支持文生视频、图生视频、文生图片、文生3D模型、图生3D模型，以及图片视频特效。
  适用于用户需要 AI 创作或生成媒体内容的场景。
  当用户提出以下意图时触发：生成/制作/创建视频、图片生成视频、生成/制作图片或插画、生成/制作3D模型、
  对图片应用特效或动效、以及泛化表述如"帮我做一个…""AI 生成…""生成一段…"等。
---

# 多模态内容生成技能

通过云端服务生成多模态内容，包括图片、视频、3D 模型生成，以及基于模板的图生视频特效。

## 能力概览

| 能力 | 命令 | 认证方式 |
|------|------|----------|
| 视频生成 | `buddy-cloud.py video` | 临时密钥优先，JWT Token 兜底（`connect_cloud_service`） |
| 图片生成 | `buddy-cloud.py image` | 临时密钥优先，JWT Token 兜底（`connect_cloud_service`） |
| 视频特效 | `buddy-cloud.py video-fx` | 临时密钥优先，JWT Token 兜底（`connect_cloud_service`） |
| 3D 模型生成 | `buddy-cloud.py 3d` | 临时密钥优先，JWT Token 兜底（`connect_cloud_service`） |

---

## 1. 视频生成

支持文生视频和图生视频，生成画面精准、流畅的短视频内容。

**示例 Prompt：**
- "黄昏时分，一列复古蒸汽火车穿过被雪覆盖的森林，蒸汽从烟囱袅袅升起，镜头缓慢跟随"
- `A paper origami crane slowly unfolds into a real crane, then flies away over a misty mountain lake, cinematic slow motion`
- "水墨晕染风格，大雨落在平静的湖面，涟漪向外扩散，远处山峦若隐若现"

---

## 2. 图片生成

从文本描述生成高质量 AI 图片，支持多种艺术风格、构图和画面细节控制。

**示例 Prompt：**
- "工笔画风格，一枝白梅斜出画框，花瓣半开，背景留白，右下角有淡墨印章"
- `Macro photography of a single dewdrop on a spider web at sunrise, golden light refracting through it, ultra-detailed`
- "包豪斯风格海报，几何色块构成城市天际线，主色调为深蓝、砖红和米白，无文字"

---

## 3. 视频特效

将静态图片转化为动态视频片段，基于预设特效模板驱动人物或物体产生动作、变身、互动等效果。目前支持 60+ 个模板，覆盖人物互动、变装变身、物理特效、风格转换等多种类型。

**示例用法：**
- 上传一张人像，应用"万物归尘"让人物化作粒子消散
- 上传两张人脸照片，应用"亲吻"生成双人互动视频
- 上传一张全身照，应用"变身机甲"将人物改造为未来战士
- 上传一张宠物图，应用"萌宠草裙舞"让猫狗跳起草裙舞
- 上传一张物品图，应用"万物生花"让主体绽放出花朵

**部分模板一览（template 取值）：**

| 类型 | 模板名 | template |
|------|--------|----------|
| 人物互动 | 拥抱 / 亲吻 / 比心 / 公主抱 / 脸颊贴贴 | `hug` / `kissing` / `hearting` / `bridalcarry` / `cheeks` |
| 变装变身 | 变身机甲 / 变身美人鱼 / 埃及变装 / 毕业啦 / 赛博朋克 | `futuresoldier` / `mermaidme` / `egyptme` / `graduation` / `cyber` |
| 物理特效 | 万物归尘 / 飞走了 / 被拽走了 / 面对疾风 / 膨胀 | `return2dust` / `balloonfly` / `dragme` / `windonface` / `morphlab` |
| 风格转换 | 动漫视频 / 卡通视频 / 3D手办风 / 毛茸茸 | `animelive` / `cartoonlive` / `3dfigure` / `fuzzy` |
| 趣味互动 | 吃我一拖鞋 / 倒头就是睡 / 被骷髅抓走了 / 捏脸 | `shoehit` / `napme` / `atomy` / `facepinch` |

完整模板列表见[官方文档](https://cloud.tencent.com/document/product/1616/119194)。

---

## 4. 3D 模型生成

基于腾讯混元大模型，将文本描述或图片生成高精度 3D 模型。支持文生3D、图生3D、多视角生3D、单几何生成（白模）、草图生3D、智能拓扑生3D。

### 4.1 调用方式

统一使用 `buddy-cloud.py 3d` 命令，支持文生3D和图生3D两种模式，提交后自动轮询等待结果。

```bash
# 文生3D
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d "文本描述" --token "<token>"

# 图生3D
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d --image-url "https://example.com/image.jpg" --token "<token>"
```

**可选参数：**

### 4.2 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `prompt` | positional | — | 文本描述，中文推荐，≤1024 字符（与 `--image-url` / `--image-base64` 三选一） |
| `--image-url` | string | — | 图片 URL，分辨率 128~5000px，≤8MB |
| `--image-base64` | string | — | 图片 Base64，分辨率 128~5000px，≤6MB |
| `--multi-view` | JSON | — | 多视角图片，格式见下方示例 |
| `--model` | string | `3.1` | 模型版本，脚本默认 3.1（API 默认 3.0）。3.1 不支持 LowPoly |
| `--enable-pbr` | flag | off | 开启 PBR 材质生成 |
| `--face-count` | int | 500000 | 面数，范围 10000~1500000 |
| `--generate-type` | string | `Normal` | `Normal` / `LowPoly` / `Geometry`（白模）/ `Sketch`（草图） |
| `--polygon-type` | string | `triangle` | 仅 LowPoly 有效：`triangle` / `quadrilateral` |
| `--result-format` | string | obj+glb | `STL` / `USDZ` / `FBX` |
| `--no-poll` | flag | off | 仅提交任务，不等待结果，返回 JobId |

**输出示例：**
```json
{
  "job_id": "job-xxxxxxxxxxxx",
  "status": "success",
  "result_files": [
    {
      "type": "glb",
      "url": "https://ai3d-xxx.cos.ap-guangzhou.myqcloud.com/xxx.glb",
      "preview_image_url": "https://ai3d-xxx.cos.ap-guangzhou.myqcloud.com/xxx.png"
    },
    {
      "type": "obj",
      "url": "https://ai3d-xxx.cos.ap-guangzhou.myqcloud.com/xxx.obj"
    }
  ]
}
```

注意：生成文件 URL 有效期为 **24 小时**，请及时保存。3D 生成通常需要 1~5 分钟。

### 4.3 查询任务状态

提交时若使用 `--no-poll`，可通过 `status` 命令查询：

```bash
python3 <SKILL_DIR>/scripts/buddy-cloud.py status <job_id> --type 3d --token "<token>"
```

### 4.4 完整调用示例

```bash
# 文生3D（基础）
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d "蒸汽朋克风格的机械鸟，黄铜齿轮外露，翅膀由精密表盘拼接而成" --token "<token>"

# 图生3D
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d --image-url "https://example.com/cat.jpg" --token "<token>"

# 使用 3.1 版本 + PBR 材质
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d "Q 版风格的古代灯笼，镂空雕花，内部有温暖的火焰光晕" --model 3.1 --enable-pbr --token "<token>"

# 自定义面数
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d "维京战船船头，龙形木雕，风化做旧的木材质感" --face-count 300000 --token "<token>"

# LowPoly 模式
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d "低多边形风格的山间小屋，被松树环绕，屋顶有积雪" --generate-type LowPoly --polygon-type quadrilateral --token "<token>"

# 白模（无纹理）
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d "未来主义风格的人形机甲，肩部装有推进器" --generate-type Geometry --token "<token>"

# 草图生成
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d --image-url "https://example.com/sketch.png" --generate-type Sketch "一把椅子" --token "<token>"

# 指定输出格式为 FBX
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d "哥特式教堂玫瑰窗，彩色玻璃镶嵌，精细石雕边框" --result-format FBX --token "<token>"

# 多视角输入
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d --image-url "https://example.com/front.jpg" \
  --multi-view '[{"ViewType":"back","ViewImageUrl":"https://example.com/back.jpg"},{"ViewType":"left","ViewImageUrl":"https://example.com/left.jpg"}]' \
  --token "<token>"

# 仅提交任务（不等待）
python3 <SKILL_DIR>/scripts/buddy-cloud.py 3d "一座城堡" --no-poll --token "<token>"

# 查询已有任务
python3 <SKILL_DIR>/scripts/buddy-cloud.py status <job_id> --type 3d --token "<token>"
```

### 4.5 API 参考

- SDK 模块：`tencentcloud.ai3d.v20250513`
- 提交接口：`SubmitHunyuanTo3DProJob`
- 查询接口：`QueryHunyuanTo3DProJob`
- Endpoint：`ai3d.tencentcloudapi.com`

**SubmitHunyuanTo3DProJob 参数说明：**

| 参数 | 类型 | 必选 | 说明 |
|------|------|------|------|
| Model | String | 否 | 模型版本，API 默认 3.0，脚本默认 3.1。可选 3.0/3.1，3.1 不支持 LowPoly |
| Prompt | String | 三选一 | 文生3D描述，中文推荐，≤1024 字符 |
| ImageUrl | String | 三选一 | 输入图 URL，分辨率 128~5000px，≤8MB |
| ImageBase64 | String | 三选一 | 输入图 Base64，分辨率 128~5000px，≤6MB |
| MultiViewImages | Array | 否 | 多视角图片，视角：left/right/back/top/bottom/left_front/right_front |
| EnablePBR | Boolean | 否 | 开启 PBR 材质，默认 false |
| FaceCount | Integer | 否 | 面数，默认 500000，范围 10000~1500000 |
| GenerateType | String | 否 | Normal/LowPoly/Geometry/Sketch，默认 Normal |
| PolygonType | String | 否 | 仅 LowPoly：triangle/quadrilateral，默认 triangle |
| ResultFormat | String | 否 | STL/USDZ/FBX，默认返回 obj+glb |

**QueryHunyuanTo3DProJob 响应字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| Status | String | WAIT：等待中，RUN：执行中，FAIL：失败，DONE：成功 |
| ErrorCode | String | 错误码 |
| ErrorMessage | String | 错误信息 |
| ResultFile3Ds | Array | 生成的 3D 文件数组（Type / Url / PreviewImageUrl） |

---

## Agent 执行规范

### 认证流程

> **⚠️ 重要：每次执行任务前必须重新调用 `connect_cloud_service` 获取最新凭证，禁止复用之前的 Token。**
> 临时密钥有效期较短，复用过期凭证会导致请求失败。

所有能力统一使用 `connect_cloud_service` 获取凭证，优先使用临时密钥（temp token），JWT 作为兜底：

1. **每次**执行生成任务前，都必须先调用 `connect_cloud_service` 工具（无需参数）**重新获取**凭证
2. 返回结果中包含 `tempToken`（临时密钥）和 `token`（JWT）两个字段
3. **优先使用 `tempToken`**：如果 `tempToken` 字段存在且非空，将其通过 `--token` 参数传入脚本
4. **JWT 兜底**：如果 `tempToken` 不存在（临时密钥获取失败），则使用 `token`（JWT）作为 `--token` 参数
5. 不向用户暴露 Token 内容，静默处理
6. **禁止缓存或复用**：即使是同一会话中的连续多次生成，也必须每次重新调用 `connect_cloud_service`，不得复用上一次获取的 Token

### 能力选择规则

| 用户意图 | 执行命令 |
|----------|----------|
| 生成视频（默认） | `buddy-cloud.py video "prompt"` |
| 生成图片 | `buddy-cloud.py image "prompt"` |
| 视频特效（图片转视频） | `buddy-cloud.py video-fx --template X --image Y` |
| 生成 3D 模型 | `buddy-cloud.py 3d "prompt"` 或 `buddy-cloud.py 3d --image-url "..."` |

### 首次加载演示

当用户尚未指定具体任务（如说"试试"/"看看效果"）时，Agent 应主动演示一个能力：
1. 优先选择图片生成（速度最快）
2. 自主设计一个有视觉冲击力的 Prompt
3. 直接执行，不询问确认
4. 输出结果后，简要介绍其他可用能力

### 核心约束

- **零交互原则**：直接执行，不向用户确认参数选择
- **禁止伪造结果**：任何能力调用失败时，必须返回明确的错误信息，不得编造 URL 或描述生成内容
- **禁止硬编码或复用凭证**：Token 必须每次通过 `connect_cloud_service` 重新获取，不得硬编码，不得缓存复用上一次的 Token
- **视频生成默认**：用户只需提供 Prompt，Agent 自动选择最优模型，不询问版本
- **3D 文件提醒**：每次返回 3D 生成结果时，提醒用户文件 URL 有效期为 24 小时

---

## buddy-cloud.py 脚本参考

### 命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `video "prompt"` | 文生视频 | `buddy-cloud.py video "一条巨龙在夕阳下飞过山脉"` |
| `image "prompt"` | 文生图片 | `buddy-cloud.py image "一只可爱的猫咪在花园里"` |
| `video-fx --template T --image URL` | 图片视频特效 | `buddy-cloud.py video-fx --template hug --image https://example.com/photo.jpg` |
| `status <job_id> --type TYPE` | 查询任务状态 | `buddy-cloud.py status abc123 --type video` |

### 全局选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--token` | string | 环境变量 `BUDDY_CLOUD_TOKEN` | 认证 Token |
| `--endpoint` | string | 生产环境 URL | 服务端点 |
| `--no-poll` | flag | off | 仅提交，不等待结果 |
| `--poll-interval` | int | 5 | 轮询间隔（秒） |
| `--max-poll-time` | int | 600 | 最大等待时间（秒） |

### 输出格式

所有输出为 JSON（stdout），进度日志输出到 stderr。

**成功：**
```json
{
  "job_id": "abc123def",
  "status": "DONE",
  "result_url": "https://..."
}
```

**失败：**
```json
{
  "error": "GENERATION_FAILED",
  "message": "The generation job failed. Please try again."
}
```

---

## 依赖

- Python 3.7+
- `requests`（脚本自动安装）
