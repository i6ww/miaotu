'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  BrainCircuit,
  Clipboard,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  Trash2,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CustomSelect } from '@/components/ui/select-custom';
import { Markdown } from '@/components/ui/markdown';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';

type ChatModelOption = {
  id: string;
  name: string;
  modelId: string;
  supportsVision: boolean;
  maxTokens: number;
  enabled: boolean;
  costPerMessage: number;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

type ChatSession = {
  id: string;
  title: string;
  messages: ChatMessage[];
  modelId: string;
  createdAt: number;
  updatedAt: number;
};

const CHAT_API_MAX_LENGTH = 2000;
const CONTEXT_BUDGET = 1800;
const CHAT_SESSIONS_STORAGE_KEY = 'sanhub-chat-sessions-v1';
const ACTIVE_CHAT_SESSION_STORAGE_KEY = 'sanhub-active-chat-session-v1';
const EMPTY_MESSAGES: ChatMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content:
      '\u4f60\u597d\uff0c\u6211\u662f\u5bf9\u8bdd\u52a9\u624b\u3002\u9009\u62e9\u4e00\u4e2a\u63a8\u7406\u6a21\u578b\uff0c\u7136\u540e\u53ef\u4ee5\u76f4\u63a5\u5f00\u59cb\u5bf9\u8bdd\u3002',
  },
];

const INITIAL_SESSION: ChatSession = {
  id: 'initial-chat-session',
  title: '\u65b0\u5bf9\u8bdd',
  messages: EMPTY_MESSAGES.map((message) => ({ ...message })),
  modelId: '',
  createdAt: 0,
  updatedAt: 0,
};

const TEXT = {
  title: '\u5bf9\u8bdd\u804a\u5929',
  subtitle: '\u8c03\u7528\u5df2\u914d\u7f6e\u7684\u63a8\u7406\u5927\u6a21\u578b',
  model: '\u6a21\u578b',
  modelPlaceholder: '\u9009\u62e9\u804a\u5929\u6a21\u578b',
  loadingModels: '\u6b63\u5728\u52a0\u8f7d\u6a21\u578b...',
  noModels: '\u6682\u65e0\u53ef\u7528\u804a\u5929\u6a21\u578b',
  clear: '\u6e05\u7a7a',
  newChat: '\u65b0\u5efa\u5bf9\u8bdd',
  conversations: '\u5bf9\u8bdd\u8bb0\u5f55',
  untitled: '\u65b0\u5bf9\u8bdd',
  noHistory: '\u6682\u65e0\u5386\u53f2\u5bf9\u8bdd',
  inputPlaceholder: '\u8f93\u5165\u4f60\u8981\u8ba8\u8bba\u7684\u5185\u5bb9...',
  send: '\u53d1\u9001',
  sending: '\u751f\u6210\u4e2d',
  copy: '\u590d\u5236',
  cost: '\u6bcf\u6b21\u6d88\u8017',
  points: '\u79ef\u5206',
  chars: '\u5b57\u7b26',
  user: '\u4f60',
  assistant: '\u52a9\u624b',
  loadFailed: '\u52a0\u8f7d\u6a21\u578b\u5931\u8d25',
  sendFailed: '\u5bf9\u8bdd\u8bf7\u6c42\u5931\u8d25',
  copied: '\u5df2\u590d\u5236',
  copiedDescription: '\u56de\u590d\u5185\u5bb9\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f',
  emptyInput: '\u8bf7\u5148\u8f93\u5165\u5185\u5bb9',
  selectModel: '\u8bf7\u5148\u9009\u62e9\u6a21\u578b',
};

function createMessageId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createChatSession(modelId = ''): ChatSession {
  const now = Date.now();
  return {
    id: createMessageId(),
    title: TEXT.untitled,
    messages: EMPTY_MESSAGES.map((message) => ({ ...message })),
    modelId,
    createdAt: now,
    updatedAt: now,
  };
}

function buildSessionTitle(input: string): string {
  const compact = input.replace(/\s+/g, ' ').trim();
  if (!compact) return TEXT.untitled;
  return compact.length > 24 ? `${compact.slice(0, 24)}...` : compact;
}

function formatSessionTime(timestamp: number, mounted: boolean): string {
  if (!mounted || !timestamp) return '--';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function isValidSession(value: unknown): value is ChatSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<ChatSession>;
  return (
    typeof session.id === 'string' &&
    typeof session.title === 'string' &&
    Array.isArray(session.messages) &&
    typeof session.createdAt === 'number' &&
    typeof session.updatedAt === 'number'
  );
}

function loadStoredSessions(): { sessions: ChatSession[]; activeSessionId: string } {
  try {
    const raw = window.localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const storedSessions = Array.isArray(parsed) ? parsed.filter(isValidSession) : [];
    const sessions = storedSessions.length > 0 ? storedSessions : [createChatSession()];
    const storedActiveId = window.localStorage.getItem(ACTIVE_CHAT_SESSION_STORAGE_KEY);
    const activeSessionId = sessions.some((session) => session.id === storedActiveId)
      ? storedActiveId!
      : sessions[0].id;

    return { sessions, activeSessionId };
  } catch {
    const session = createChatSession();
    return { sessions: [session], activeSessionId: session.id };
  }
}

function buildConversationPrompt(messages: ChatMessage[], input: string): string {
  const history = messages.filter((message) => message.id !== 'welcome');
  const lines = [
    'You are continuing a chat conversation. Use the recent conversation as context and answer the latest user message directly.',
    '',
  ];

  for (const message of history.slice(-8)) {
    lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`);
  }
  lines.push(`User: ${input}`);

  const prompt = lines.join('\n');
  if (prompt.length <= CONTEXT_BUDGET) {
    return prompt;
  }

  return prompt.slice(prompt.length - CONTEXT_BUDGET);
}

export function ChatPage() {
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [sessions, setSessions] = useState<ChatSession[]>([INITIAL_SESSION]);
  const [activeSessionId, setActiveSessionId] = useState(INITIAL_SESSION.id);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeSession = sessions.find((session) => session.id === activeSessionId) || sessions[0];
  const messages = activeSession?.messages || EMPTY_MESSAGES;
  const selectedModel = models.find((model) => model.id === selectedModelId);

  const modelOptions = useMemo(
    () =>
      models.map((model) => ({
        value: model.id,
        label: model.name,
        description: `${model.modelId} · ${TEXT.cost} ${model.costPerMessage} ${TEXT.points}`,
        highlight: model.supportsVision,
      })),
    [models]
  );

  const updateActiveSession = (
    updater: (session: ChatSession) => ChatSession
  ) => {
    const targetSessionId = activeSession?.id || activeSessionId;
    setSessions((current) =>
      current.map((session) => (session.id === targetSessionId ? updater(session) : session))
    );
  };

  const updateSession = (
    sessionId: string,
    updater: (session: ChatSession) => ChatSession
  ) => {
    setSessions((current) =>
      current.map((session) => (session.id === sessionId ? updater(session) : session))
    );
  };

  useEffect(() => {
    setHasMounted(true);
    const stored = loadStoredSessions();
    setSessions(stored.sessions);
    setActiveSessionId(stored.activeSessionId);
    const active = stored.sessions.find((session) => session.id === stored.activeSessionId);
    if (active?.modelId) {
      setSelectedModelId(active.modelId);
    }
  }, []);

  useEffect(() => {
    if (!hasMounted || !activeSessionId) return;

    window.localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    window.localStorage.setItem(ACTIVE_CHAT_SESSION_STORAGE_KEY, activeSessionId);
  }, [activeSessionId, hasMounted, sessions]);

  // Reload models on browser tab focus and a low-frequency poll so admin
  // channel/model toggles reach open user pages quickly.
  useEffect(() => {
    const refreshModels = async (isInitial: boolean) => {
      try {
        if (isInitial) setModelsLoading(true);
        const response = await fetch('/api/chat/models', { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || TEXT.loadFailed);
        }

        const enabledModels = (payload.data || []).filter((model: ChatModelOption) => model.enabled);
        setModels(enabledModels);
        setSelectedModelId((current) => {
          if (current && enabledModels.some((model: ChatModelOption) => model.id === current)) return current;
          // fall back to the first model when the current one was disabled
          return enabledModels[0]?.id || '';
        });
      } catch (error) {
        // only surface errors on the initial load; keep the stale list on refresh failures
        if (isInitial) {
          toast({
            title: TEXT.loadFailed,
            description: error instanceof Error ? error.message : TEXT.loadFailed,
            variant: 'destructive',
          });
        }
      } finally {
        if (isInitial) setModelsLoading(false);
      }
    };

    void refreshModels(true);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshModels(false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const timer = setInterval(() => {
      if (!document.hidden) void refreshModels(false);
    }, 60000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(timer);
    };
  }, [activeSession?.modelId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isSending]);

  const handleCopy = async (content: string) => {
    await navigator.clipboard.writeText(content);
    toast({
      title: TEXT.copied,
      description: TEXT.copiedDescription,
    });
  };

  const handleClear = () => {
    updateActiveSession((session) => ({
      ...session,
      messages: EMPTY_MESSAGES.map((message) => ({ ...message })),
      updatedAt: Date.now(),
    }));
    setInput('');
    inputRef.current?.focus();
  };

  const handleNewChat = () => {
    const session = createChatSession(selectedModelId);
    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    setInput('');
    inputRef.current?.focus();
  };

  const handleSelectSession = (session: ChatSession) => {
    setActiveSessionId(session.id);
    setSelectedModelId(session.modelId || selectedModelId);
    setInput('');
    inputRef.current?.focus();
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModelId(modelId);
    updateActiveSession((session) => ({
      ...session,
      modelId,
      updatedAt: Date.now(),
    }));
  };

  const handleSubmit = async () => {
    const trimmedInput = input.trim();
    if (!trimmedInput) {
      toast({ title: TEXT.emptyInput, variant: 'destructive' });
      return;
    }
    if (!selectedModelId) {
      toast({ title: TEXT.selectModel, variant: 'destructive' });
      return;
    }

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: 'user',
      content: trimmedInput,
    };

    const targetSessionId = activeSession?.id || activeSessionId;
    const nextMessages = [...messages, userMessage];
    const prompt = buildConversationPrompt(messages, trimmedInput).slice(0, CHAT_API_MAX_LENGTH);
    updateSession(targetSessionId, (session) => ({
      ...session,
      title: session.title === TEXT.untitled ? buildSessionTitle(trimmedInput) : session.title,
      messages: nextMessages,
      modelId: selectedModelId,
      updatedAt: Date.now(),
    }));
    setInput('');
    setIsSending(true);

    try {
      const response = await fetch('/api/chat/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: selectedModelId,
          prompt,
        }),
      });

      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || TEXT.sendFailed);
      }

      updateSession(targetSessionId, (session) => ({
        ...session,
        messages: [
          ...session.messages,
          {
            id: createMessageId(),
            role: 'assistant',
            content: payload.data?.content || '',
          },
        ],
        updatedAt: Date.now(),
      }));
    } catch (error) {
      updateSession(targetSessionId, (session) => ({
        ...session,
        messages: [
          ...session.messages,
          {
            id: createMessageId(),
            role: 'assistant',
            content: error instanceof Error ? error.message : TEXT.sendFailed,
          },
        ],
        updatedAt: Date.now(),
      }));
      toast({
        title: TEXT.sendFailed,
        description: error instanceof Error ? error.message : TEXT.sendFailed,
        variant: 'destructive',
      });
    } finally {
      setIsSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-100px)] max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/50 p-4 shadow-[0_8px_24px_rgba(0,0,0,0.22)] sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/10">
            <BrainCircuit className="h-5 w-5 text-sky-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-wide text-foreground">{TEXT.title}</h1>
            <p className="text-sm text-foreground/50">{TEXT.subtitle}</p>
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-[22rem] sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleNewChat}
            title={TEXT.newChat}
            aria-label={TEXT.newChat}
          >
            <Plus className="h-4 w-4" />
          </Button>
          <CustomSelect
            value={selectedModelId}
            onValueChange={handleModelChange}
            options={modelOptions}
            disabled={modelsLoading || models.length === 0}
            placeholder={modelsLoading ? TEXT.loadingModels : TEXT.modelPlaceholder}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleClear}
            title={TEXT.clear}
            aria-label={TEXT.clear}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto rounded-xl border border-border/70 bg-card/35 p-2 lg:hidden">
        {sessions.map((session) => {
          const isActive = session.id === activeSession?.id;

          return (
            <button
              key={session.id}
              type="button"
              onClick={() => handleSelectSession(session)}
              className={cn(
                'min-w-36 rounded-lg border px-3 py-2 text-left transition-colors',
                isActive
                  ? 'border-sky-500/35 bg-sky-500/10 text-foreground'
                  : 'border-border/70 bg-background/35 text-foreground/65'
              )}
            >
              <p className="truncate text-xs font-medium">{session.title}</p>
              <p className="mt-1 text-[10px] text-foreground/40">
                {formatSessionTime(session.updatedAt, hasMounted)}
              </p>
            </button>
          );
        })}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/40">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {messages.map((message) => {
              const isUser = message.role === 'user';
              const Icon = isUser ? User : Bot;

              return (
                <div
                  key={message.id}
                  className={cn(
                    'flex gap-3',
                    isUser ? 'justify-end' : 'justify-start'
                  )}
                >
                  {!isUser && (
                    <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/60">
                      <Icon className="h-4 w-4 text-sky-400" />
                    </div>
                  )}
                  <div
                    className={cn(
                      'group max-w-[min(48rem,88%)] rounded-xl border px-4 py-3 text-sm leading-6',
                      isUser
                        ? 'border-sky-500/35 bg-sky-500/10 text-foreground'
                        : 'border-border/70 bg-background/55 text-foreground/85'
                    )}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-foreground/45">
                      <span>{isUser ? TEXT.user : TEXT.assistant}</span>
                      {!isUser && message.id !== 'welcome' && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 opacity-100 transition hover:bg-card/70 hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
                          onClick={() => void handleCopy(message.content)}
                        >
                          <Clipboard className="h-3 w-3" />
                          {TEXT.copy}
                        </button>
                      )}
                    </div>
                    {isUser ? (
                      <p className="whitespace-pre-wrap break-words">{message.content}</p>
                    ) : (
                      <div className="prose prose-invert max-w-none break-words prose-p:my-0">
                        <Markdown content={message.content} />
                      </div>
                    )}
                  </div>
                  {isUser && (
                    <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-sky-500/25 bg-sky-500/10">
                      <Icon className="h-4 w-4 text-sky-300" />
                    </div>
                  )}
                </div>
              );
            })}

            {isSending && (
              <div className="flex items-center gap-3 text-sm text-foreground/50">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/70 bg-background/60">
                  <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                </div>
                <span>{TEXT.sending}</span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="border-t border-border/70 bg-card/60 p-3">
            <div className="flex gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value.slice(0, CHAT_API_MAX_LENGTH))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    void handleSubmit();
                  }
                }}
                placeholder={TEXT.inputPlaceholder}
                className="min-h-20 flex-1 resize-none rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-sky-500/50 focus:ring-2 focus:ring-sky-500/10"
                disabled={isSending}
              />
              <Button
                type="button"
                size="icon"
                className="h-20 w-12 shrink-0"
                disabled={isSending || !input.trim() || !selectedModelId}
                onClick={() => void handleSubmit()}
                title={TEXT.send}
                aria-label={TEXT.send}
              >
                {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-foreground/40">
              <span>{selectedModel ? `${selectedModel.name} · ${TEXT.cost} ${selectedModel.costPerMessage} ${TEXT.points}` : TEXT.noModels}</span>
              <span>{input.length} / {CHAT_API_MAX_LENGTH} {TEXT.chars}</span>
            </div>
          </div>
        </section>

        <aside className="hidden min-h-0 rounded-xl border border-border/70 bg-card/40 p-4 lg:flex lg:flex-col">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-sky-400" />
              <h2 className="text-sm font-semibold text-foreground">{TEXT.conversations}</h2>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={handleNewChat}
              title={TEXT.newChat}
              aria-label={TEXT.newChat}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {sessions.length === 0 ? (
              <p className="text-sm text-foreground/45">{TEXT.noHistory}</p>
            ) : (
              sessions.map((session) => {
                const isActive = session.id === activeSession?.id;
                const messageCount = session.messages.filter((message) => message.id !== 'welcome').length;

                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => handleSelectSession(session)}
                    className={cn(
                      'w-full rounded-lg border p-3 text-left transition-colors',
                      isActive
                        ? 'border-sky-500/35 bg-sky-500/10 text-foreground'
                        : 'border-border/70 bg-background/35 text-foreground/65 hover:bg-background/60 hover:text-foreground'
                    )}
                  >
                    <p className="truncate text-sm font-medium">{session.title}</p>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-foreground/40">
                      <span>{messageCount} messages</span>
                      <span>{formatSessionTime(session.updatedAt, hasMounted)}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="mt-4 border-t border-border/70 pt-4">
            <div className="mb-3 flex items-center gap-2">
              <BrainCircuit className="h-4 w-4 text-sky-400" />
              <h2 className="text-sm font-semibold text-foreground">{TEXT.model}</h2>
            </div>
            {selectedModel ? (
              <div className="space-y-3 text-sm">
                <div className="rounded-lg border border-border/70 bg-background/50 p-3">
                  <p className="font-medium text-foreground">{selectedModel.name}</p>
                  <p className="mt-1 break-all text-xs text-foreground/45">{selectedModel.modelId}</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-foreground/55">
                  <div className="rounded-lg border border-border/70 bg-background/40 p-3">
                    <p className="text-foreground/35">Max tokens</p>
                    <p className="mt-1 font-semibold text-foreground">{selectedModel.maxTokens}</p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/40 p-3">
                    <p className="text-foreground/35">{TEXT.cost}</p>
                    <p className="mt-1 font-semibold text-foreground">{selectedModel.costPerMessage}</p>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-foreground/45">{modelsLoading ? TEXT.loadingModels : TEXT.noModels}</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
