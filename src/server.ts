import "dotenv/config";
import express, { Request, Response } from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { Agent, createTool } from "@voltagent/core";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
  Message,
  MessageBody,
  SessionItem,
} from "./types";

// ---------- Simple file-based message store ----------
const DATA_DIR = path.resolve(process.cwd(), "data");
const MSG_FILE = path.join(DATA_DIR, "messages.json");
const SESS_FILE = path.join(DATA_DIR, "sessions.json");

function ensureStore(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(MSG_FILE)) {
    fs.writeFileSync(MSG_FILE, JSON.stringify({ messages: [] }, null, 2));
  }
  if (!fs.existsSync(SESS_FILE)) {
    fs.writeFileSync(SESS_FILE, JSON.stringify({ sessions: [] }, null, 2));
  }
}

function readStore(): { messages: Message[] } {
  ensureStore();
  const raw = fs.readFileSync(MSG_FILE, "utf8");
  return JSON.parse(raw) as { messages: Message[] };
}

function writeStore(data: { messages: Message[] }): void {
  fs.writeFileSync(MSG_FILE, JSON.stringify(data, null, 2));
}

function readSessions(): { sessions: SessionItem[] } {
  ensureStore();
  const raw = fs.readFileSync(SESS_FILE, "utf8");
  return JSON.parse(raw) as { sessions: SessionItem[] };
}

function writeSessions(data: { sessions: SessionItem[] }): void {
  fs.writeFileSync(SESS_FILE, JSON.stringify(data, null, 2));
}

function getSessionsForUser(userId: string): SessionItem[] {
  const data = readSessions();
  return data.sessions
    .filter((s) => s.userId === userId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function upsertSession(item: SessionItem): void {
  const data = readSessions();
  const idx = data.sessions.findIndex((s) => s.id === item.id);
  if (idx >= 0) {
    data.sessions[idx] = item;
  } else {
    data.sessions.push(item);
  }
  writeSessions(data);
}

function addMessage(msg: Message): void {
  const data = readStore();
  data.messages.push(msg);
  writeStore(data);
}

function markMessagesDelivered(ids: string[]): void {
  if (!ids || ids.length === 0) return;
  const data = readStore();
  let changed = false;
  const now = Date.now();
  data.messages = data.messages.map((m) => {
    if (ids.includes(m.id) && !m.delivered) {
      changed = true;
      return { ...m, delivered: true, deliveredAt: now };
    }
    return m;
  });
  if (changed) writeStore(data);
}

// ---------- Server & Socket setup ----------
const app = express();
const server = http.createServer(app);
const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(server);

// Serve static client from dist/public after build
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req: Request, res: Response) => res.send("ok"));

// Track online users: userId -> socketId
const onlineUsers = new Map<string, string>();

// ---------- VoltAgent setup ----------
if (!process.env.OPENAI_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn(
    "OPENAI_API_KEY not set. AI streaming will fail until provided."
  );
}

// --------- Tools for testing offline + chaining ---------
const weatherTool = createTool({
  name: "get_weather",
  description: "Get the current weather for a specific location (mock).",
  parameters: z.object({
    location: z.string().describe("City name, e.g., 上海/北京"),
  }),
  execute: async ({ location }) => {
    // sleep 5s
    await new Promise((resolve) => setTimeout(resolve, 5000));
    // Mocked weather; random-ish but bounded
    const temp = Math.round(18 + Math.random() * 12); // 18-30°C
    const conditions = ["sunny", "cloudy", "rainy"][
      Math.floor(Math.random() * 3)
    ];
    // eslint-disable-next-line no-console
    console.log(
      `[tool:get_weather] location=${location} -> temp=${temp}, cond=${conditions}`
    );
    return { temperature: temp, conditions, location };
  },
});

const playSpotTool = createTool({
  name: "suggest_play_spot",
  description:
    "Suggest a place to play based on temperature (mock, random pick).",
  parameters: z.object({
    temperature: z.number().describe("Temperature in Celsius"),
  }),
  execute: async ({ temperature }) => {
    // sleep 5s
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const candidates = ["外滩", "颐和园", "西湖"];
    const place = candidates[Math.floor(Math.random() * candidates.length)];
    // eslint-disable-next-line no-console
    console.log(
      `[tool:suggest_play_spot] temp=${temperature} -> place=${place}`
    );
    return { place, recommendedFor: temperature };
  },
});

const agent = new Agent({
  name: "AI Chat Assistant",
  instructions:
    "你是一个简洁友好的助理。若用户询问“今天适合去哪玩”，先调用 get_weather 获取天气（若未指定地点，默认使用“上海”），再调用 suggest_play_spot，传入上一条工具返回的 temperature，最后给出简短建议。",
  model: openai("gpt-5"),
  tools: [weatherTool, playSpotTool],
});

// Stream state kept local inside startAIStream(); no global map.

function getUndeliveredMessagesFor(userId: string): Message[] {
  const data = readStore();
  return data.messages.filter((m) => m.to === userId && !m.delivered);
}

async function startAIStream(userId: string, sessionId: string, input: string) {
  // Use a streaming session id (persist only final text message)
  const messageId = crypto.randomUUID();

  // notify client (if connected) to create a bubble
  const targetSocketId = onlineUsers.get(userId);
  if (targetSocketId) {
    io.to(targetSocketId).emit("ai_started", { id: messageId, sessionId });
  }

  // Local state per stream
  let textSoFar = "";
  let done = false;

  try {
    const response = await agent.streamText(input);

    // Process full stream (text deltas, tool calls, tool results, finish)
    for await (const event of (response as any).fullStream) {
      if (event.type === "text-delta") {
        const delta: string = event.text ?? "";
        if (!done && delta) {
          textSoFar += delta;
          const sid = onlineUsers.get(userId);
          if (sid)
            io.to(sid).emit("ai_chunk", { id: messageId, sessionId, delta });
        }
      } else if (event.type === "tool-call") {
        // persist tool-call as a message (offline replay)
        const toolMsg: Message = {
          id: crypto.randomUUID(),
          to: userId,
          sessionId,
          timestamp: Date.now(),
          delivered: false,
          role: "system",
          message: { type: "tool_use", content: event.toolName } as MessageBody,
        };
        addMessage(toolMsg);
        const sid = onlineUsers.get(userId);
        if (sid) {
          io.to(sid).emit("ai_tool_call", { sessionId, name: event.toolName });
          markMessagesDelivered([toolMsg.id]);
        }
      } else if (event.type === "tool-result") {
        const toolResMsg: Message = {
          id: crypto.randomUUID(),
          to: userId,
          sessionId,
          timestamp: Date.now(),
          delivered: false,
          role: "system",
          message: {
            type: "tool_result",
            content: event.toolName,
          } as MessageBody,
        };
        addMessage(toolResMsg);
        const sid = onlineUsers.get(userId);
        if (sid) {
          io.to(sid).emit("ai_tool_result", {
            sessionId,
            name: event.toolName,
          });
          markMessagesDelivered([toolResMsg.id]);
        }
      } else if (event.type === "finish") {
        // no-op; final text handled below via response.text
      }
    }

    // Final values resolve when streaming completes
    const finalText = await (response as any).text;
    textSoFar = finalText || textSoFar;
    done = true;
    // Persist final message only now
    const finalMsg: Message = {
      id: messageId,
      to: userId,
      sessionId,
      timestamp: Date.now(),
      delivered: false,
      role: "ai",
      message: { type: "text", content: textSoFar || "" } as MessageBody,
    };
    addMessage(finalMsg);

    // If user online at finish time, emit completion and mark delivered
    const sid = onlineUsers.get(userId);
    if (sid) {
      io.to(sid).emit("ai_complete", {
        id: messageId,
        sessionId,
        text: textSoFar || "",
      });
      markMessagesDelivered([messageId]);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("AI stream error:", err);
    // Mark local done (optional)
    done = true;
  } finally {
    // no global stream registry; nothing to cleanup here
  }
}

io.on("connection", (socket) => {
  socket.on("register", ({ userId }) => {
    if (!userId) return;
    socket.data.userId = userId;
    onlineUsers.set(userId, socket.id);

    // Push session list
    const sessions = getSessionsForUser(userId);
    socket.emit("session_list", sessions);

    // For an active AI stream, don't replay current buffer; new chunks will stream.
  });

  // Create a session
  socket.on("session_create", ({ sessionId, title }) => {
    const userId = socket.data.userId;
    if (!userId || !sessionId) return;
    const now = Date.now();
    const existing = getSessionsForUser(userId).find((s) => s.id === sessionId);
    const item = {
      id: sessionId,
      userId,
      title: title && title.trim() ? title : existing?.title || "新会话",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as SessionItem;
    upsertSession(item);
    socket.emit("session_list", getSessionsForUser(userId));
  });

  // Open a session and send its messages
  socket.on("session_open", ({ sessionId }) => {
    const userId = socket.data.userId;
    if (!userId || !sessionId) return;
    const data = readStore();
    const msgs = data.messages
      .filter((m) => m.to === userId && m.sessionId === sessionId)
      .sort((a, b) => a.timestamp - b.timestamp);
    socket.emit("session_messages", { sessionId, messages: msgs });
  });

  // User -> AI: start streaming response in session
  socket.on("ai_send", ({ sessionId, text }) => {
    const from = socket.data.userId;
    if (!from || !text || !sessionId) return;
    // Persist user message immediately so it appears in history
    const userMsg: Message = {
      id: crypto.randomUUID(),
      to: from,
      sessionId,
      timestamp: Date.now(),
      delivered: true,
      deliveredAt: Date.now(),
      role: "user",
      message: { type: "text", content: text },
    };
    addMessage(userMsg);
    startAIStream(from, sessionId, text);
    // bump session updatedAt
    const sessions = getSessionsForUser(from);
    const target = sessions.find((s) => s.id === sessionId);
    if (target) {
      upsertSession({ ...target, updatedAt: Date.now() });
    }
  });

  socket.on("disconnect", () => {
    const userId = socket.data.userId;
    if (userId) {
      if (onlineUsers.get(userId) === socket.id) {
        onlineUsers.delete(userId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});
