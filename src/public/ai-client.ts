(() => {
  type MessageBody =
    | { type: 'text'; content: string }
    | { type: 'tool_use'; content: string }
    | { type: 'tool_result'; content: string };
  type Message = {
    id: string;
    to: string;
    sessionId: string;
    timestamp: number;
    delivered: boolean;
    deliveredAt?: number;
    role: 'user' | 'ai' | 'system';
    message: MessageBody;
  };

  let socket: any = null;
  const els = {
    status: document.getElementById('status') as HTMLSpanElement,
    btnSend: document.getElementById('btnSend') as HTMLButtonElement,
    msgInput: document.getElementById('msgInput') as HTMLInputElement,
    messages: document.getElementById('messages') as HTMLUListElement,
    btnNewSession: document.getElementById('btnNewSession') as HTMLButtonElement,
    sessionList: document.getElementById('sessionList') as HTMLUListElement,
  };

  const aiBubbles = new Map<string, HTMLLIElement>(); // messageId -> li
  let currentSessionId: string | null = null;
  function addSystemNote(text: string) {
    const li = document.createElement('li');
    li.className = 'system';
    li.textContent = text;
    els.messages.appendChild(li);
    li.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function setStatus(text: string) {
    els.status.textContent = text;
  }

  function escapeHtml(str: string) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function addUserBubble(text: string) {
    const li = document.createElement('li');
    li.className = 'self';
    li.innerHTML = `<div>${escapeHtml(text)}</div>`;
    els.messages.appendChild(li);
    li.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function ensureAIBubble(id: string): HTMLLIElement {
    let li = aiBubbles.get(id);
    if (!li) {
      li = document.createElement('li');
      li.className = 'incoming';
      li.innerHTML = `<div class="ai-text"></div>`;
      els.messages.appendChild(li);
      aiBubbles.set(id, li);
    }
    return li;
  }

  function setAIBubbleText(id: string, text: string) {
    const li = ensureAIBubble(id);
    const textDiv = li.querySelector('.ai-text') as HTMLDivElement;
    textDiv.innerHTML = escapeHtml(text);
    li.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function ensureUserId(): string {
    const key = 'ai_chat_user_id';
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const anyWin = window as any;
    const gen = anyWin.crypto?.randomUUID?.() || ('u-' + Math.random().toString(36).slice(2));
    localStorage.setItem(key, gen);
    return gen;
  }
  const userId = ensureUserId();

  function connect(userId: string) {
    if (socket) {
      try { socket.disconnect(); } catch {}
      socket = null;
    }
    const ioClient = (window as any).io;
    socket = ioClient();
    setStatus('连接中…');

    socket.on('connect', () => {
      setStatus('已连接');
      socket.emit('register', { userId });
    });

    socket.on('disconnect', () => setStatus('已断开'));

    // Session list and messages
    socket.on('session_list', (items: { id: string; title: string }[]) => {
      renderSessionList(items);
      if (!currentSessionId && items.length > 0) {
        currentSessionId = items[0].id;
        socket.emit('session_open', { sessionId: currentSessionId });
        renderSessionList(items);
      }
    });
    socket.on('session_messages', (payload: { sessionId: string; messages: Message[] }) => {
      if (!currentSessionId || payload.sessionId !== currentSessionId) return;
      els.messages.innerHTML = '';
      aiBubbles.clear();
      payload.messages.forEach((m) => {
        if (m.message.type === 'text') {
          if (m.role === 'user') {
            addUserBubble(m.message.content || '');
          } else {
            setAIBubbleText(m.id, m.message.content || '');
          }
        } else if (m.message.type === 'tool_use') {
          addSystemNote(`🔧 调用工具: ${m.message.content}`);
        } else if (m.message.type === 'tool_result') {
          addSystemNote(`✅ 工具完成: ${m.message.content}`);
        }
      });
    });

    // Streaming lifecycle
    socket.on('ai_started', ({ id, sessionId }: { id: string; sessionId: string }) => {
      if (!currentSessionId || sessionId !== currentSessionId) return;
      ensureAIBubble(id);
    });
    socket.on('ai_chunk', ({ id, sessionId, delta }: { id: string; sessionId: string; delta: string }) => {
      if (!currentSessionId || sessionId !== currentSessionId) return;
      const li = ensureAIBubble(id);
      const textDiv = li.querySelector('.ai-text') as HTMLDivElement;
      textDiv.innerHTML = (textDiv.innerHTML || '') + escapeHtml(delta);
      li.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    socket.on('ai_complete', ({ id, sessionId, text }: { id: string; sessionId: string; text: string }) => {
      if (!currentSessionId || sessionId !== currentSessionId) return;
      setAIBubbleText(id, text);
    });

    // Tool lifecycle
    socket.on('ai_tool_call', ({ sessionId, name }: { sessionId: string; name: string }) => {
      if (!currentSessionId || sessionId !== currentSessionId) return;
      addSystemNote(`🔧 调用工具: ${name}`);
    });
    socket.on('ai_tool_result', ({ sessionId, name }: { sessionId: string; name: string }) => {
      if (!currentSessionId || sessionId !== currentSessionId) return;
      addSystemNote(`✅ 工具完成: ${name}`);
    });
  }

  function renderSessionList(items: { id: string; title: string }[]) {
    els.sessionList.innerHTML = '';
    items.forEach((it) => {
      const li = document.createElement('li');
      li.textContent = it.title || '未命名会话';
      if (it.id === currentSessionId) li.classList.add('active');
      li.addEventListener('click', () => {
        currentSessionId = it.id;
        renderSessionList(items.map(s => ({ id: s.id, title: s.title })));
        els.messages.innerHTML = '';
        aiBubbles.clear();
        socket.emit('session_open', { sessionId: currentSessionId });
      });
      els.sessionList.appendChild(li);
    });
  }

  function sendToAI() {
    if (!socket || socket.disconnected) return;
    const text = els.msgInput.value.trim();
    if (!text) return;
    if (!currentSessionId) {
      // Auto create a new session if none selected
      currentSessionId = (window as any).crypto?.randomUUID?.() || ('s-' + Math.random().toString(36).slice(2));
      socket.emit('session_create', { sessionId: currentSessionId });
      socket.emit('session_open', { sessionId: currentSessionId });
    }
    addUserBubble(text);
    socket.emit('ai_send', { sessionId: currentSessionId, text });
    els.msgInput.value = '';
  }

  els.btnSend.addEventListener('click', sendToAI);
  els.msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendToAI();
    }
  });

  // Auto connect
  connect(userId);

  // New session button
  els.btnNewSession.addEventListener('click', () => {
    const sid = (window as any).crypto?.randomUUID?.() || ('s-' + Math.random().toString(36).slice(2));
    currentSessionId = sid;
    socket.emit('session_create', { sessionId: sid });
    socket.emit('session_open', { sessionId: sid });
  });
})();
