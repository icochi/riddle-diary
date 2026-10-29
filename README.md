# Riddle Diary (汤姆·里德尔的日记本 3D 交互场景)

[![Node.js Tests](https://img.shields.io/badge/tests-128%20passing-brightgreen.svg)](#)
[![Three.js](https://img.shields.io/badge/Three.js-0.186.1-black.svg)](https://threejs.org/)
[![Vite](https://img.shields.io/badge/Vite-8.3.1-646CFF.svg)](https://vitejs.dev/)

高保真 3D 沉浸式复刻《哈利·波特与密室》中经典的**汤姆·里德尔日记本**（Tom Riddle's Diary）。基于 Three.js 与程序化着色器构建，呈现真实纸质翻页动力学、羽毛笔定轴避让导轨、3D 立体滴墨与 GPU 级铁胆墨水毛细渗流、消融与反向纤维显影。

> 📺 **视频**：[作为 Chrome 扩展替换豆包皮肤展示](https://www.bilibili.com/video/BV1uZsd6MEcu/)

---

## ✨ 核心特性

### 1. 物理姿态网格与拟真翻书 (Baked Book & Morph Poses)
- **参数化烘焙模型**：源自 Blender 烘焙的真实皮革封皮、金属护角与 50 片实体书芯页片（`diary-book.glb`）。
- **51 阶姿态键插值**：包含完整合上（进度 0）到完全摊开（进度 12）的非线性物理翻页轨迹，真实还原封面弧长补偿、书脊装订下沉（Spine Sink）与铰链避让。
- **程序化古旧内页**：内页着色器实时计算羊皮纸纤维斑驳、外缘焦褐渐变与受光曲面法线，支持单页物理翻飞动画。
- **智能运镜调度 (Camera Director)**：在全景浏览、中缝平移、翻飞对焦与正对书写四阶段运镜间平滑插值；在完全摊平后根据鼠标悬停区域在斜俯全局与垂直正对书写机位间自适应切换。

### 2. 羽毛笔导轨与运动学系统 (Quill Rig & Plume Kinematics)
- **空间贝塞尔轨迹**：翻开日记落定后，羽毛笔从墨水瓶以空间四控制点抛物线平滑拔出，合书时平滑插回。
- **笔尖定轴避让 (Nib-Pivoted Clearance)**：笔尖绝对锚定纸面接触点，羽梢通过解析胶囊体（Analytic Capsule）与运动学解算器自适应俯仰与侧向偏摆，彻底杜绝刺穿桌面或切入书页。
- **墨水瓶磁吸与蘸墨**：光标靠近墨水瓶时触发瓶口磁吸垂直悬停，支持点击墨水瓶触发拟真“双连探入蘸墨”动作。

### 3. 电影级墨迹物理管线 (Ink Physics & GPU Dissolution)
- **待输入 3D 立体墨滴 (InkDroplet3D)**：在当前打字位置原位凝结晶莹凸起的半球形 3D 墨珠，响应台灯纯净高光，随后塌缩渗入纸面转化为 2D 墨核并激发分形蛛网毛细脉络扩散，最后被纸张纤维吸干消失，周期循环。
- **原生中文 IME 支持**：原位隐藏式透明输入锚点，光标随字迹末尾定位，原生输入法候选浮窗贴合就近弹出。
- **GPU 片元文字消融与显影**：由着色器 Uniform `uTextDissolve` 驱动形态学距离场收缩与三阶段古乌茶褐渐变，实现无贴图重传的 120 FPS 满帧流体消融与反向纤维显影。
- **开场题跋 SVG 消融**：翻开摊平落定时自动联动演播开场花体题跋 SVG 的灰度反显与中轴骨架消融。

### 4. 沉浸式对话演播与双页历史回响 (Chat Ink Lifecycle & Session Echo)
- **对话墨迹生命周期**：回车提交提问 $\rightarrow$ 提问文字被纸面吸干 $\rightarrow$ AI 应答以反向毛细显影凝聚浮现 $\rightarrow$ 按字数积分停留阅读 $\rightarrow$ 整屏文字吸干并归还空白。
- **左页历史篇章索引**：羊皮纸左页展示会话目录，支持悬停手绘微弧下划线交互与代际隔离保护。
- **流式历史回响演播**：切换历史篇章时触发单页立体翻页，双页自上而下流动呈现历史问答反显、阅读停留与消融，支持即时打断与未提交草稿无损复原。

---

## 🚀 快速开始

### 环境依赖
- Node.js >= 18.0.0
- npm / pnpm / yarn

### 安装
```bash
git clone <repository-url>
cd riddle-diary
npm install
```

### 开发环境启动
```bash
npm run dev
```
启动本地 Vite 开发服务器，在浏览器中打开 `http://localhost:5173`。

### 生产环境打包
```bash
npm run build
```
打包输出产物位于 `dist/` 目录。

### 生产预览
```bash
npm run preview
```

### 运行自动化测试
```bash
npm test
```
执行 Node.js 原生测试套件，覆盖物理运动学、墨迹渗流场、对话状态机与着色器逻辑（128 项测试）。

---

## 🎮 操作指南

| 交互动作 | 操作方式 | 效果说明 |
| :--- | :--- | :--- |
| **翻开 / 翻合日记** | 点击日记本封面 / 按键盘 `Space` 或 `Enter` | 触发 0~12 进度物理翻页动画及开场题跋演播 |
| **退出并合书** | 点击日记本外部的桌面背景 | 立即退出书写，保留草稿，日记本平滑合上并收回羽毛笔 |
| **自由书写** | 日记本完全摊开后直接打字 | 原生支持中英文、标点与输入法；羽毛笔跟随笔尖微动 |
| **提交提问** | 按键盘 `Enter` 键 | 触发提问文字吸干吞噬，开启 AI 对话演播周期 |
| **悬停视角切换** | 鼠标移入/移出书本网格 | 自动平滑过渡为垂直俯视书写机位或斜俯立体纵览机位 |
| **快速蘸墨** | 鼠标点击桌面左下方墨水瓶 | 羽毛笔飞至瓶口并执行快速双连探入蘸墨动画 |
| **切换历史篇章** | 鼠标点击左页历史目录标题 | 触发单页翻页与双页流式历史回响演播，点击任意处可打断 |

---

## 📁 目录结构

```text
riddle-diary/
├── public/                 # 静态资产
│   └── assets/
│       ├── diary-book.glb  # 3D 日记本网格与 51 阶姿态键
│       ├── quill.glb       # 羽毛笔模型
│       ├── ink-bottle.glb  # 厚玻璃墨水瓶模型
│       ├── single-leaf.glb # 单页翻页动画模型
│       ├── image.svg       # 开场题跋 SVG 资产
│       ├── fonts/          # 手写体与古典书法字体资源
│       └── textures/       # 封皮烘焙贴图与法线/粗糙度纹理
├── src/                    # 源代码
│   ├── main.js             # 场景装配、主渲染循环与事件总线
│   ├── stage.js            # Three.js 场景基座、灯光与渲染器
│   ├── book.js             # 摊平书深模块，装配材质与姿态键驱动
│   ├── book-playback.js    # 翻页调度器与时间轴积分状态机
│   ├── camera-director.js  # 四阶段运镜与悬停机位平滑调度器
│   ├── pages.js            # 内页程序化着色器与 GPU 墨水消融 Uniforms
│   ├── quill.js            # 羽毛笔跟随导轨系统 (Quill Rig)
│   ├── quill-kinematics.js # 笔尖定轴避让与羽梢避障运动学解算器
│   ├── quill-bottle-sequence.js # 瓶口时序调度与双连蘸墨控制
│   ├── ink.js              # 墨迹书写总装层与 2D/3D 动态贴图合成
│   ├── ink-droplet-3d.js   # 3D 饱满半球墨珠网格与塌缩模拟
│   ├── ink-bleed.js        # Voronoi 细胞骨架与毛细渗透物理算法
│   ├── ink-dissolve-driver.js # GPU 片元消融调度驱动
│   ├── svg-ink-pipeline.js # SVG 开场题跋灰度反显与中轴骨架消融
│   ├── chat-ink-director.js# 对话墨迹周期与 SessionEpoch 代际调度器
│   ├── session-echo-playback.js # 历史消息流式回响演播
│   └── scene-interaction-dispatcher.js # 视锥射线物理碰撞仲裁
├── test/                   # 自动化测试套件 (128 项单元/集成测试)
├── docs/                   # 架构文档与历史 ADR 记录
│   └── adr/                # 架构决策记录 (Architectural Decision Records)
├── CONTEXT.md              # 领域模型定义与设计原则
├── index.html              # 应用单页入口
└── package.json            # 项目依赖与脚本配置
```

---

## 📜 架构与设计规范

- **单上下文布局**：全局领域模型及受控术语详见 [`CONTEXT.md`](./CONTEXT.md)，严禁随意混淆概念。
- **深模块设计 (Deep Module)**：纯粹的业务逻辑与数学算法（如 `PlumeKinematics`、`BookPlayback`、`ChatInkDirector` 等）均与 DOM / 引擎渲染实现零耦合，具备高内聚的小接口和完备的断言测试。
- **架构决策跟踪**：所有重大演进与技术选型均按 ADR 规范记录于 [`docs/adr/`](./docs/adr/)。

---

## 📄 License

MIT License. Designed & Developed with Harry Potter Nostalgia.
