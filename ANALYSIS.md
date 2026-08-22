# 原站实现分析 — twewy-message-generator

分析对象：https://twewygenerator.heckingsne.cc/ （作者 Errant）
本文件说明它「如何实现」以及关键技术细节，并对照本项目（`dialogue-generator/`）的设计取舍。
原始素材/源码的取证件在 `../twewy-gen/reference/`（含从 sourcemap 恢复出的 `src/` 源码）。

---

## 1. 整体架构

- **技术栈**：Create React App（CRA）构建的 React 单页应用 + Tailwind CSS v3。
  发布物是纯静态站（`index.html` + `static/js/main.ccf2f0a5.js` 350KB + CSS）。
- **核心依赖**：`react`、`react-select`（下拉）、`react-accessible-accordion`（折叠面板）、
  `html-to-image`（DOM→PNG 导出）。
- **关键取证**：线上发布了 `main.ccf2f0a5.js.map`（840KB sourcemap），从中可完整恢复
  应用源码：`App.js`（892 行）、`resources/functions/{imageManip,magicNum,images,updateHandlers}.js`。

## 2. 数据模型

页面状态就是一个对象 `dialogueSettings`：

```
{
  Dialogue1: { enabled, text, type: 'default'|'thought'|'wiggly'|'loud', flip },
  Dialogue2: { enabled, text, type, flip },          // 两个气泡：后层 + 前层
  CLeftFore:  { enabled, name, expression },          // 左前
  CLeftBack:  { enabled, name, expression },          // 左后
  CRightFore: { enabled, name, expression },          // 右前
  CRightBack: { enabled, name, expression },          // 右后
}
```

- **角色槽位是 4 个**：左/右 × 前/后，即"单侧最多两人"（这就是原版对单侧多人的支持方式）。
- `charaData` 表描述每个角色：`expressions`（表情数）、`height`（立绘高度系数，默认 0.85）、
  `xOffset`（Tailwind 负 margin 类，如 `-space-x-20`、`-ml-24`，控制前后槽位叠放）、
  `offsetOverride`（某些表情的偏移修正）。
- 立绘按 `chara/{name}{expression}.png` 命名，`require.context` 批量注册为 hash 后的 URL。

## 3. 渲染管线（重点）

画布规格来自 `magicNum.js`：

```js
export const height = 500
export const divCoefficient = 1 / 483 * 644   // ≈ 1.3333…（对应 DS 256×192 的 4:3）
export const width = height * divCoefficient  // ≈ 666.67 px
```

`TwewyCanvas` 的绘制顺序（对应 CSS z-index）：

1. 黑色底 → **背景**（`CroppedBackground`）
2. **后层气泡**（Dialogue1，z=3）
3. **后层立绘**（CLeftBack/CRightBack，z=4）
4. **前层立绘**（CLeftFore/CRightFore，z=5）
5. **前层气泡**（Dialogue2，z=6）
6. **文字**（z=20，绝对定位居中，黑字 + 0.5px -webkit-text-stroke）

各元素都用 `ImageCropper`（`imageManip.js`）画到 `<canvas>` 上 —— 一个通用"裁剪缩放"组件：

```js
// ImageCropper: 从原图裁出 (leftRight, topBottom) 指定的九宫格中段，缩放到 newWidth×newHeight
cropLeft = leftRight[0];  cropTop = topBottom[0];
cropWidth = img.width - leftRight[0] - leftRight[1];
ctx.drawImage(img, cropLeft, cropTop, cropWidth, cropHeight, 0, 0, newWidth, newHeight);
```

- **背景**：`leftRight=[0,760]` → 把原图右侧 760px 裁掉再拉伸到 667×500（DS 背景图在右侧
  通常有超出屏幕的作画）。
- **立绘**：`newHeight = 500 × height系数`，`marginTop = 500×(1−系数)+1`；左侧角色
  `rotateY(180°)` 镜像朝内；前后槽位用负 margin 叠放（`-space-x-20` 等）。
- **气泡**：`newHeight = 500/2.3 ≈ 217.4px`，宽度按原图宽高比自动缩放；两个气泡纵向
  排列并 `-space-y-10`（重叠 40px）+ `mt-4`；带 `drop-shadow(0.4rem 0.4rem black)` 投影，
  `flip` 时投影反向。
- **文字**：20px、居中、`white-space: pre-line`——**原版不自动换行**，长句靠手动换行。

## 4. 图片导出

```js
toPng(imageRef.current, { cacheBust: false, skipAutoScale: true })  // html-to-image
  .then(dataUrl => { a.download = "TWEWY_Screencap.png"; a.href = dataUrl; a.click(); })
```

`html-to-image` 的做法：克隆目标 DOM 节点 → 把 CSS 计算样式内联 → 图片/字体转成
data:URI 嵌入 → 序列化成 SVG `<foreignObject>` → 画到 canvas → `toDataURL()`。
纯前端、无服务端，像素与页面所见一致。

## 5. 素材管线

- 素材放 `resources/images/{bg,bubbles,chara}`，CRA 按 `require.context` 编译后输出到
  `static/media/` 并加内容 hash（本次已下载：4 张气泡图、约 90 张背景、40+ 角色表情、字体）。
- 字体 `FOT-NewCezanne Pro M.otf`（TWEWY 的 UI 字体，6.1MB）通过 `@font-face` 引入，
  class `font-newCez` 应用。
- 角色表情统一 `nameN.png`（N=1..expressions），如 `neku1.png`～`neku14.png`。
- 背景命名 `Event_BG_xxxx_01_aNN.jpg`，`bgNames` 表把 `ce001_01` 等批量映射到 a01~a13 子图。

## 6. 已知限制（原版）

- 没有"序列"概念：一次只能编排**一帧**静态画面。
- 文本不自动换行；4 个角色全开时官方提示"可能出现奇怪的错位"（偏移量是手调 Tailwind 类）。
- 气泡 flip 完全手动；没有名字标签（TWEWY 原作气泡本就不显示名字）。
- 无分支/跳转/打字机/批量导出。

---

## 7. 本项目的设计（对照）

目标：保留原版的画面语言，把"单帧编辑器"升级为"**脚本驱动的互动序列生成器**"。

| 能力 | 原版 | 本项目 |
| --- | --- | --- |
| 画面构成 | 4 槽位立绘 + 双气泡 + 背景 | 同款布局（复刻布局数学） |
| 编排方式 | 表单点选 | **文本脚本 DSL**（`!actor` / 行内 `{box=,expr=,flip=}`）+ **所见即所得行编辑器** |
| 素材管理 | 无 | **资源页**：角色立绘多表情（每张可单独缩放/位移，随包导出）、地点多画面（早/中/晚）、BGM、音效、角色语音，`chara://` `loc://` `bgm://` `sfx://` 引用，JSON 打包分享 |
| 音频 | 无 | Web Audio 引擎：`@bgm` 循环 BGM / `@sfx` 一次音效 / 行属性 `voice=n` 播放角色语音，三路音量；**代次令牌保证任意时刻仅一路 BGM**（快速跳转/重放不叠加）；批量导出静音 |
| 播放/录制 | 无 | 播放模式自动走完脚本（选择自动取第一项，可循环）；canvas.captureStream + MediaRecorder 录制 WebM（含音频轨） |
| 文字 | 手动换行 | 自动换行（`@wrap`）+ `\n` 保留 |
| 名字 | 无 | 气泡名字标签（`@shownames`） |
| 序列 | 无 | 逐句播放：打字机、上下句、跳转、选择分支 |
| 转场 | 无（静态） | 句间转场：旧框上移淡出 + 新框自画面中下方升起（均 ease-out 快起慢动，`@transdur`/`@transdist` 可调） |
| 多人 | 每侧 2 槽（硬编码偏移） | 每侧最多 4 槽（`slot0..3`，`@slotgap` 可调） |
| 导出 | 单帧 667×500 | 单帧 + **批量导出全部帧**，倍率可调（默认 2x） |
| 角色素材 | 捆绑 TWEWY 立绘 | **不捆绑**，玩家自备（占位图可换） |
| 对话框素材 | 捆绑 | 复用（default/thought/wiggly/loud） |

### 实现要点

- **`js/parser.js`**：纯函数行解析器（无 DOM 依赖，可在 Node 单测），输出扁平 op 序列：
  `bg / actor / sprite / setopt / speech / choice / jump / label / end`，并带源行号。
- **`js/player.js`**：状态机。`applyOpState(op)` 只改场景状态（背景、角色、选项），
  遇到 `speech`/`choice` 才"呈现"（打字机 or 菜单）；`next/prev/restart/seekTo` 围绕游标 +
  快照实现（prev 靠逐帧场景快照回放）；`exportAll` 以回放模式跑完全序列逐句出图，
  带死循环保护（2 万步上限）。
- **`js/renderer.js`**：复刻原版画布数学（667×500、气泡高 217.4、投影 6.4px、槽位叠放、
  背景右裁 760），把原版的 z-index 序直接映射为绘制顺序。文本用 Canvas 测量换行，
  中文走 `Microsoft YaHei` 回退。
- **导出**：不依赖 `html-to-image`，直接**用同一渲染器画到离屏 canvas**——批量导出就是
  播放器的"无头回放"，像素与预览一致，且天然支持倍率缩放。

## 8. 素材来源与版权

对话框、背景、字体为《The World Ends With You》（© Square Enix）游戏素材，
原站作者公开使用；本项目仅用于学习研究，商用请自行替换素材。占位立绘由
`tools/gen_placeholders.js` 程序化生成（零依赖 PNG 编码），无版权问题。
