import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArrowUp, CornerDownLeft, LockKeyhole, Plus, Sparkles, Square, UserRound } from 'lucide-react';
import type { AssistantChatInput, AssistantChatMessage } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
const STORAGE_KEY = 'smalltalk-current-conversation-v1';

type Message = AssistantChatMessage & {
  id: string;
  createdAt: string;
};

const starterPrompts = [
  { title: 'Help me untangle a tricky decision', label: 'THINK IT THROUGH', prompt: 'I have a decision I keep going back and forth on. Can you help me think it through?' },
  { title: 'Make this week feel more manageable', label: 'FIND A STARTING POINT', prompt: 'I have a lot on my plate this week. Help me figure out a calm, realistic plan.' },
  { title: 'Explain something I have been curious about', label: 'GET A CLEAR ANSWER', prompt: 'Explain how habits form in a way that is clear, useful, and not too technical.' },
  { title: 'Find the right words for a message', label: 'WRITE WITH ME', prompt: 'Help me write a thoughtful message to someone I have not spoken to in a while.' },
];

function makeId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readConversation(): Message[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Message =>
      item && typeof item.id === 'string' &&
      (item.role === 'user' || item.role === 'assistant') &&
      typeof item.content === 'string' && typeof item.createdAt === 'string'
    );
  } catch {
    return [];
  }
}

function formatTime(isoDate: string) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function inlineText(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith('`') && part.endsWith('`')
      ? <code key={`${index}-${part}`}>{part.slice(1, -1)}</code>
      : <span key={`${index}-${part}`}>{part}</span>
  );
}

function FormattedReply({ content, streaming }: { content: string; streaming: boolean }) {
  const blocks = content.split(/```/);
  const rendered = blocks.map((block, index) => {
    if (index % 2 === 1) {
      const firstBreak = block.indexOf('\n');
      const code = firstBreak >= 0 ? block.slice(firstBreak + 1) : block;
      return <pre key={`code-${index}`}><code>{code.replace(/\n$/, '')}</code></pre>;
    }
    return block.split(/\n{2,}/).filter(Boolean).map((paragraph, paragraphIndex) => (
      <p key={`p-${index}-${paragraphIndex}`}>{inlineText(paragraph)}</p>
    ));
  });
  return <div className="message-content">{rendered}{streaming && <span className="stream-cursor" aria-label="Assistant is responding" />}</div>;
}

function Home() {
  const [messages, setMessages] = useState<Message[]>(readConversation);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // The conversation remains usable for this session when storage is unavailable.
    }
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming, error]);

  async function requestReply(history: AssistantChatMessage[], assistantId: string) {
    const controller = new AbortController();
    activeController.current = controller;
    setStreaming(true);
    setError(null);
    try {
      const input: AssistantChatInput = { messages: history.slice(-20) };
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = '';
        try {
          const result = await response.json() as { error?: string };
          detail = result.error ?? '';
        } catch {
          detail = '';
        }
        throw new Error(detail || `The assistant could not respond (error ${response.status}).`);
      }
      if (!response.body) throw new Error('A response stream was not available. Please try again.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let complete = false;
      const processFrame = (frame: string) => {
        const payload = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!payload) return;
         let event: { content?: string; done?: boolean; error?: string };
        try {
           event = JSON.parse(payload) as { content?: string; done?: boolean; error?: string };
        } catch {
          return;
        }
         if (event.error) throw new Error(event.error);
        if (typeof event.content === 'string' && event.content.length) {
          setMessages((current) => current.map((message) =>
            message.id === assistantId ? { ...message, content: message.content + event.content } : message
          ));
        }
        if (event.done) complete = true;
      };

      while (!complete) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        frames.forEach(processFrame);
        if (done) {
          if (buffer.trim()) processFrame(buffer);
          break;
        }
      }
      if (!complete) throw new Error('The response ended before it was complete. Please try again.');
    } catch (caught) {
      setMessages((current) => current.filter((message) => message.id !== assistantId));
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.');
      }
    } finally {
      if (activeController.current === controller) activeController.current = null;
      setStreaming(false);
    }
  }

  function submitMessage(content: string) {
    const trimmed = content.trim();
    if (!trimmed || streaming) return;
    const userMessage: Message = { id: makeId(), role: 'user', content: trimmed, createdAt: new Date().toISOString() };
    const assistantId = makeId();
    const assistantMessage: Message = { id: assistantId, role: 'assistant', content: '', createdAt: new Date().toISOString() };
    const updated = [...messages, userMessage, assistantMessage];
    setMessages(updated);
    setDraft('');
    setError(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    void requestReply(updated.filter((message) => message.role !== 'assistant' || message.id !== assistantId).map(({ role, content: messageContent }) => ({ role, content: messageContent })), assistantId);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitMessage(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitMessage(draft);
    }
  }

  function onDraftChange(value: string) {
    setDraft(value);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    }
  }

  function startFresh() {
    activeController.current?.abort();
    activeController.current = null;
    setStreaming(false);
    setMessages([]);
    setDraft('');
    setError(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function retryLast() {
    if (streaming) return;
    const history = messages.map(({ role, content }) => ({ role, content }));
    if (!history.length) return;
    const assistantId = makeId();
    setError(null);
    setMessages((current) => [...current, { id: assistantId, role: 'assistant', content: '', createdAt: new Date().toISOString() }]);
    void requestReply(history, assistantId);
  }

  function stopReply() {
    activeController.current?.abort();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Little Lantern AI Assistant">
          <span className="brand-mark" aria-hidden="true"><Sparkles size={16} strokeWidth={1.8} /></span>
          <span>little lantern</span>
        </div>
        <div className="topbar-right">
          <span className="privacy-note"><LockKeyhole size={13} strokeWidth={1.8} /> History stays in this browser</span>
          <button className="fresh-button" type="button" onClick={startFresh} data-testid="button-new-conversation" aria-label="Start a fresh conversation">
            <Plus size={15} strokeWidth={2} /> <span>New chat</span>
          </button>
        </div>
      </header>

      <section className="chat-frame" aria-label="Conversation">
        <div className="chat-scroll">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="orbit-mark" aria-hidden="true"><Sparkles size={25} strokeWidth={1.55} /></div>
              <p className="empty-kicker">A little help, right when you need it</p>
              <h1 className="empty-title">What’s on<br />your <em>mind?</em></h1>
              <p className="empty-copy">Ask anything, big or small. We’ll take it one thoughtful answer at a time.</p>
              <div className="prompt-grid" aria-label="Suggested questions">
                {starterPrompts.map((prompt) => (
                  <button
                    className="prompt-card"
                    key={prompt.label}
                    type="button"
                    data-testid={`button-prompt-${prompt.label.toLowerCase().replaceAll(' ', '-')}`}
                    onClick={() => submitMessage(prompt.prompt)}
                    disabled={streaming}
                  >
                    <span>{prompt.title}</span>
                    <span>{prompt.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list" role="log" aria-live="polite" aria-relevant="additions text" data-testid="list-messages">
              {messages.map((message, index) => {
                const isUser = message.role === 'user';
                const isCurrentStream = !isUser && streaming && index === messages.length - 1;
                return (
                  <article className={`message-row ${isUser ? 'user' : 'assistant'}`} key={message.id} data-testid={`message-${message.role}-${message.id}`}>
                    {!isUser && <span className="message-avatar" aria-hidden="true"><Sparkles size={14} /></span>}
                    <div className="message-body">
                      <div className="message-meta">
                        <span className="message-name">{isUser ? 'You' : 'Little lantern'}</span>
                        <time className="message-time" dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                      </div>
                      {isUser
                        ? <div className="user-bubble">{message.content}</div>
                        : message.content
                          ? <FormattedReply content={message.content} streaming={isCurrentStream} />
                          : isCurrentStream
                            ? <div className="thinking" aria-label="Thinking"><span /><span /><span /></div>
                            : null}
                    </div>
                    {isUser && <span className="message-avatar user-avatar" aria-hidden="true"><UserRound size={14} /></span>}
                  </article>
                );
              })}
              {error && (
                <div className="error-box" role="alert" data-testid="status-chat-error">
                  <span>{error}</span>
                  <button className="retry-button" type="button" onClick={retryLast} data-testid="button-retry">Try again</button>
                </div>
              )}
              <div className="scroll-anchor" ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="composer-area">
          <form className="composer" onSubmit={onSubmit}>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask anything..."
              rows={1}
              maxLength={3500}
              aria-label="Your message"
              data-testid="input-message"
              disabled={streaming}
            />
            {streaming ? (
              <button className="send-button" type="button" onClick={stopReply} aria-label="Stop response" data-testid="button-stop">
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button className="send-button" type="submit" disabled={!draft.trim()} aria-label="Send message" data-testid="button-send">
                <ArrowUp size={18} strokeWidth={2.2} />
              </button>
            )}
          </form>
          <div className="composer-hint">
            <span>{streaming ? <span className="stop-label">Responding — stop anytime</span> : <>A quiet space to think out loud.</>}</span>
            <span><kbd>Enter</kbd> to send <CornerDownLeft size={11} style={{ display: 'inline', verticalAlign: '-2px', marginLeft: 3 }} /> <span style={{ marginLeft: 7 }}>·</span> <kbd style={{ marginLeft: 7 }}>Shift + Enter</kbd> for a new line</span>
          </div>
        </div>
        {messages.length === 0 && <div className="scroll-anchor" ref={bottomRef} />}
      </section>
    </main>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
