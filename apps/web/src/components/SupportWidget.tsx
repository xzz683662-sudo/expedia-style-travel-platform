'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SupportChatConversation, type SupportChatMessage } from '@/lib/api';
import { readToken, readUser, onSessionChange } from '@/lib/session';
import { useRealtimeEvent } from '@/components/RealtimeProvider';
import { usePathname } from 'next/navigation';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

/**
 * ---------------------------------------------------------------------------
 * Embedded support chat
 * ---------------------------------------------------------------------------
 *
 * A floating bubble on the storefront that opens a 1:1 thread with the support
 * console. Three deliberate choices:
 *
 *  1. **Sign-in is required to start.** An anonymous thread would need an
 *     identity the API does not have, and a token-less conversation is a spam
 *     surface. The bubble still shows to guests — it explains what sign-in
 *     unlocks rather than hiding the feature.
 *  2. **Realtime pushes; the thread rehydrates from the API.** Every event
 *     updates the open thread and the unread count, and a reload re-reads the
 *     same history, so nothing depends on the socket having been connected.
 *  3. **Messages are de-duplicated by id.** The API echoes the sender's own
 *     message back over the socket, so the optimistic-free path (append the
 *     response, ignore the duplicate event) keeps one copy without trusting
 *     ordering.
 */
export function SupportWidget({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);
  const pathname = usePathname();

  const [token, setToken] = useState<string | null>(null);
  const [firstName, setFirstName] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [conversation, setConversation] = useState<SupportChatConversation | null>(null);
  const [messages, setMessages] = useState<SupportChatMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seenIds = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const appendMessages = useCallback((incoming: SupportChatMessage[]) => {
    setMessages((current) => {
      const additions = incoming.filter((message) => !seenIds.current.has(message.id));
      if (additions.length === 0) return current;
      for (const message of additions) seenIds.current.add(message.id);
      return [...current, ...additions];
    });
  }, []);

  // Reads the session after hydration, and follows it: a login/logout swaps the
  // token, which changes who the thread belongs to.
  useEffect(() => {
    const sync = () => {
      const stored = readToken();
      setToken(stored);
      // A named greeting ("Hi Alex") matches how the reference help centre
      // opens, and costs a localStorage read rather than another request.
      setFirstName(stored ? (readUser<{ firstName?: string }>()?.firstName ?? null) : null);
      if (!stored) {
        setConversation(null);
        setMessages([]);
        seenIds.current = new Set();
        setUnread(0);
      }
    };
    sync();
    return onSessionChange(sync);
  }, []);

  // Fetch the shopper's thread list once signed in, so the bubble can carry an
  // unread badge before the panel is ever opened.
  useEffect(() => {
    if (!token) return;
    api
      .myChats(token)
      .then((result) => {
        setUnread(result.unread);
        const first = result.items[0];
        if (first) setConversation((current) => current ?? first);
      })
      .catch(() => undefined);
  }, [token]);

  // Live updates. `support.*` events carry the conversation id and the message,
  // so this stays a pure reducer over what the server already decided.
  useRealtimeEvent((event) => {
    if (!event.type.startsWith('support.')) return;
    const payload = event.payload as {
      conversationId?: string;
      message?: SupportChatMessage | null;
      customerUnread?: number;
    };
    if (!payload.conversationId) return;
    if (conversation && payload.conversationId !== conversation.id) return;

    if (payload.message) appendMessages([payload.message]);
    if (typeof payload.customerUnread === 'number') {
      setUnread(open ? 0 : payload.customerUnread);
    }
  });

  // Keep the newest message in view.
  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [open, messages]);

  const loadThread = useCallback(
    async (id: string) => {
      if (!token) return;
      try {
        const result = await api.chatThread(id, token);
        setConversation(result.conversation);
        seenIds.current = new Set(result.messages.map((message) => message.id));
        setMessages(result.messages);
        setUnread(0);
      } catch {
        setError(t('chat.loadFailed'));
      }
    },
    [token, t],
  );

  async function openPanel() {
    setOpen(true);
    setError(null);
    if (!token) return;

    try {
      if (conversation) {
        await loadThread(conversation.id);
      } else {
        const created = await api.openChat({}, token);
        await loadThread(created.id);
      }
    } catch {
      setError(t('chat.loadFailed'));
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!token || !conversation) return;
    const body = draft.trim();
    if (!body) return;

    setBusy(true);
    setError(null);
    try {
      const message = await api.sendChatMessage(conversation.id, body, token);
      appendMessages([message]);
      setDraft('');
    } catch {
      setError(t('chat.sendFailed'));
    } finally {
      setBusy(false);
    }
  }

  // The staff consoles have their own reply surface; a shopper bubble over an
  // agent's inbox would be noise.
  if (pathname.startsWith('/admin') || pathname.startsWith('/support')) return null;

  return (
    <div className="support-widget" data-testid="support-widget">
      {open && (
        <section className="chat-panel card" aria-label={t('chat.title')} data-testid="support-panel">
          <header className="chat-panel-head">
            <div className="stack-sm" style={{ gap: 0 }}>
              <strong className="small">{t('chat.title')}</strong>
              <span className="tiny subtle">{t('chat.subtitle')}</span>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label={t('chat.close')}>
              ✕
            </button>
          </header>

          {!token ? (
            <div className="chat-signin stack">
              <p className="small muted" style={{ margin: 0 }}>
                {t('chat.signInRequired')}
              </p>
              <Link href="/login" className="btn btn-primary btn-sm">
                {t('chat.signInCta')}
              </Link>
            </div>
          ) : (
            <>
              <div className="chat-messages" ref={scrollRef} data-testid="support-messages">
                {messages.length === 0 && (
                  <p className="small subtle center chat-empty">
                    {firstName ? t('chat.greetingNamed', firstName) : t('chat.greeting')}
                  </p>
                )}
                {messages.map((message) => {
                  const mine = message.authorType === 'CUSTOMER';
                  return (
                    <div key={message.id} className={`chat-msg ${mine ? 'mine' : 'theirs'} ${message.authorType === 'SYSTEM' ? 'system' : ''}`}>
                      <span className="tiny subtle">{mine ? t('chat.youLabel') : t('chat.agentLabel')}</span>
                      <p className="small" style={{ margin: 0 }}>
                        {message.body}
                      </p>
                    </div>
                  );
                })}
              </div>

              {error && <p className="form-error small" style={{ margin: 0 }}>{error}</p>}

              <form className="chat-composer" onSubmit={send}>
                <input
                  className="input"
                  placeholder={t('chat.placeholder')}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={4000}
                  data-testid="support-input"
                />
                <button className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} data-testid="support-send">
                  {busy ? t('chat.sending') : t('chat.send')}
                </button>
              </form>
            </>
          )}
        </section>
      )}

      <button
        className="chat-bubble"
        onClick={() => (open ? setOpen(false) : void openPanel())}
        aria-label={open ? t('chat.close') : t('chat.unreadAria', unread)}
        aria-expanded={open}
        data-testid="support-bubble"
      >
        <span aria-hidden>{open ? '✕' : '💬'}</span>
        {!open && unread > 0 && <span className="chat-bubble-badge">{unread}</span>}
      </button>
    </div>
  );
}
