# AI 流式聊天（Socket.IO + VoltAgent）

一个带“会话列表 + 聊天框”的单用户 AI 聊天示例：
- 使用 Node.js + Express + Socket.IO 提供前后端一体化服务
- 使用 VoltAgent（ai-sdk v5 风格）进行流式输出，支持工具调用
- 支持离线：页面关闭后服务端继续生成，重新打开可回看完整对话与工具轨迹
- 支持多会话：左侧会话列表，可新建/切换会话，每个会话独立保存历史
- 本地文件持久化（data/messages.json 与 data/sessions.json）

## 环境要求
- Node.js 18+（推荐 20+）
- 已申请可用的 OpenAI API Key

## 安装
```
npm install
```

## 配置
在项目根目录创建 `.env` 文件：
```
OPENAI_API_KEY=你的OpenAI密钥
```
项目内已使用 `dotenv` 自动加载 `.env`。

## 启动（生产构建）
```
npm start
```
- 构建到 `dist/` 并启动服务
- 打开浏览器访问: `http://localhost:3000`

## 使用说明
- 左侧点击“新建会话”创建一个会话；或点击已有会话查看历史。
- 右侧输入消息后回车或点击“发送”。
- 流式输出：AI 回复会逐字出现；
  - 工具调用与工具结果会以灰色系统行显示（“🔧 调用工具 / ✅ 工具完成”）。
- 离线：关闭页面时服务端仍继续生成；
  - 重新打开页面并点击该会话，会看到完整历史（包括工具调用轨迹与最终文本）。

## 主要能力与实现要点
- 流式生成：`agent.streamText()` + `response.fullStream`，前端通过 `ai_chunk` 实时渲染；仅最终文本入库，减少无谓写入。
- 工具链示例：
  - `get_weather(location: string)`：随机温度与天气
  - `suggest_play_spot(temperature: number)`：从“外滩/颐和园/西湖”随机推荐
  - 当问“今天适合去哪玩？”时，Agent 会先查天气再给推荐。
- 多会话：
  - 前端生成 `sessionId`，服务端使用 `sessionId` 将消息归档；
  - `session_create` 上报/创建会话，`session_open` 拉取该会话全部历史。
- 持久化：
  - `data/messages.json`：统一消息结构 `{ id, to, sessionId, timestamp, delivered, role, message }`
    - `message` 为 JSON：`{ type: 'text'|'tool_use'|'tool_result', content: string }`
    - 用户发送的消息也会立即落库（role: 'user'）
  - `data/sessions.json`：会话列表 `{ id, userId, title, createdAt, updatedAt }`
- 断线不中断生成：
  - 与 OpenAI 的流式连接由服务端维护，socket 断开不影响生成；
  - 仅最终文本和工具事件落库，恢复时按会话完整回放。

## 开发模式（可选）
```
npm run dev
```
- 使用 tsx watch 启动 `src/server.ts`，保存自动重启

## 关键文件
- `src/server.ts`：服务端 + Socket.IO + VoltAgent + 文件存储
- `public/index.html` / `public/style.css`：前端页面与样式
- `src/public/ai-client.ts`：前端逻辑（会话管理、流式渲染、工具提示）
- `data/messages.json`、`data/sessions.json`：运行后自动生成的持久化数据

## 常见问题
- 没有读取到 OPENAI_API_KEY？
  - 确保 `.env` 位于项目根目录，并重启服务。
- 看到工具调用但没有“打字机回放”？
  - 设计上仅保存最终文本，流式中间 token 不落库（精简写入，页面在线时仍可看到流式过程）。

