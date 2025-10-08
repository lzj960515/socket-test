export type MessageBody =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; content: string }
  | { type: 'tool_result'; content: string };

export interface Message {
  id: string;
  to: string; // user id
  sessionId: string; // chat session id
  timestamp: number;
  delivered: boolean; // delivered to UI
  deliveredAt?: number;
  role: 'user' | 'ai' | 'system';
  message: MessageBody; // normalized message content
}

export interface SessionItem {
  id: string;
  userId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ClientToServerEvents {
  register: (payload: { userId: string }) => void;
  ai_send: (payload: { sessionId: string; text: string }) => void;
  session_create: (payload: { sessionId: string; title?: string }) => void;
  session_open: (payload: { sessionId: string }) => void;
}

export interface ServerToClientEvents {
  ai_started: (payload: { id: string; sessionId: string }) => void;
  ai_chunk: (payload: { id: string; sessionId: string; delta: string }) => void;
  ai_complete: (payload: { id: string; sessionId: string; text: string }) => void;
  ai_tool_call: (payload: { sessionId: string; name: string }) => void;
  ai_tool_result: (payload: { sessionId: string; name: string }) => void;
  session_list: (items: SessionItem[]) => void;
  session_messages: (payload: { sessionId: string; messages: Message[] }) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  userId?: string;
}
