'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SupportChatConversation, type SupportChatMessage } from '@/lib/api';
import { readToken } from '@/lib/session';
import { useRealtimeEvent } from '@/components/RealtimeProvider';
import { formatDate } from '@/lib/format';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

/**
 * ---------------------------------------------------------------------------
 * Support inbox
 * ---------------------------------------------------------------------------
 *
 * The staff half of the embedded chat: the queue on the left, the thread on the
 * right. It is the same conversation data the shopper's widget renders, so an
 * agent never has to reconcile two views.
 *
 * New messages arrive over the existing staff socket (`support.message` is
 * addressed to `role:SUPPORT` / `role:ADMIN`), which is why opening a
 * conversation marks it read on the server and the queue re-sorts itself.
 */

type Filter = 'OPEN' | 'CLOSED' | 'ALL';

export function SupportInbox({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);

  const [token, setToken] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('OPEN');
  const [items, setItems] = useState<SupportChatConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<SupportChatConversation | null>(null);
  const [messages, setMessages] = useState<SupportChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seenIds = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setToken(readToken());
  }, []);

  const loadInbox = useCallback(
    async (activeToken: string, activeFilter: Filter) => {
      try {
        const result = await api.supportInbox({ status: activeFilter }, activeToken);
        setItems(result.items);
        return result.items;
      } catch {
        setError(t('support.noConversations'));
        return [] as SupportChatConversation[];
      }
    },
    [t],
  );

  const openConversation = useCallback(
    async (activeToken: string, id: string) => {
      setSelectedId(id);
      try {
        const result = await api.supportConversation(id, activeToken);
        setConversation(result.conversation);
        seenIds.current = new Set(result.messages.map((message) => message.id));
        setMessages(result.messages);
      } catch {
        setError(t('support.noConversations'));
      }
    },
    [t],
  );

  useEffect(() => {
    if (!token) return;
    void loadInbox(token, filter);
  }, [token, filter, loadInbox]);

  // Live queue: a new customer message should surface without a refresh, and if
  // it belongs to the open thread it should appear in place.
  useRealtimeEvent((event) => {
    if (!token || !event.type.startsWith('support.')) return;
    const payload = event.payload as { conversationId?: string; message?: SupportChatMessage | null };
    if (payload.message && payload.conversationId && payload.conversationId === selectedId) {
      setMessages((current) => {
        if (seenIds.current.has(payload.message!.id)) return current;
        seenIds.current.add(payload.message!.id);
        return [...current, payload.message!];
      });
    }
    void loadInbox(token, filter);
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function reply(event: React.FormEvent) {
    event.preventDefault();
    if (!token || !selectedId) return;
    const body = draft.trim();
    if (!body) return;

    setBusy(true);
    setError(null);
    try {
      const message = await api.supportReply(selectedId, body, token);
      if (!seenIds.current.has(message.id)) {
        seenIds.current.add(message.id);
        setMessages((current) => [...current, message]);
      }
      setDraft('');
    } catch {
      setError(t('chat.sendFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function assignToMe() {
    if (!token || !selectedId) return;
    try {
      const updated = await api.supportAssign(selectedId, token);
      setConversation(updated);
      await loadInbox(token, filter);
    } catch {
      setError(t('chat.sendFailed'));
    }
  }

  async function toggleStatus() {
    if (!token || !selectedId || !conversation) return;
    try {
      const updated =
        conversation.status === 'OPEN'
          ? await api.supportCloseConversation(selectedId, token)
          : await api.supportReopenConversation(selectedId, token);
      setConversation(updated);
      await loadInbox(token, filter);
    } catch {
      setError(t('chat.sendFailed'));
    }
  }

  return (
    <div className="inbox" data-testid="support-inbox">
      <aside className="inbox-queue card">
        <div className="inbox-filters">
          {(['OPEN', 'CLOSED', 'ALL'] as Filter[]).map((value) => (
            <button
              key={value}
              className={`btn btn-sm ${filter === value ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFilter(value)}
            >
              {value === 'OPEN' ? t('support.filterOpen') : value === 'CLOSED' ? t('support.filterClosed') : t('support.filterAll')}
            </button>
          ))}
        </div>

        {items.length === 0 ? (
          <p className="small muted" style={{ padding: 'var(--sp-3)' }}>
            {t('support.noConversations')}
          </p>
        ) : (
          <ul className="inbox-list">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  className={`inbox-item ${selectedId === item.id ? 'active' : ''}`}
                  onClick={() => token && void openConversation(token, item.id)}
                  data-testid="inbox-item"
                >
                  <span className="row" style={{ justifyContent: 'space-between', gap: 'var(--sp-2)' }}>
                    <strong className="small truncate">{item.customer?.name ?? t('support.customerLabel')}</strong>
                    {item.staffUnread > 0 && <span className="badge badge-critical tiny">{item.staffUnread}</span>}
                  </span>
                  <span className="tiny subtle truncate">{item.subject}</span>
                  <span className="tiny subtle truncate">{item.lastPreview ?? ''}</span>
                  <span className="tiny subtle">
                    {formatDate(item.lastMessageAt, locale)}
                    {item.status === 'CLOSED' ? ` · ${t('support.statusClosed')}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="inbox-thread card">
        {!conversation ? (
          <p className="small muted" style={{ padding: 'var(--sp-5)' }}>
            {t('support.selectConversation')}
          </p>
        ) : (
          <>
            <header className="inbox-thread-head">
              <div className="stack-sm" style={{ gap: 0 }}>
                <strong className="small">
                  {conversation.customer?.name ?? t('support.customerLabel')} · {conversation.subject}
                </strong>
                <span className="tiny subtle">
                  {conversation.customer?.email ?? ''}
                  {conversation.orderId ? ` · ${t('support.relatedOrder')}` : ''}
                  {conversation.assignedToUserId ? ` · ${t('support.assignedToYou')}` : ` · ${t('support.unassigned')}`}
                </span>
              </div>
              <div className="row" style={{ gap: 'var(--sp-2)' }}>
                <button className="btn btn-ghost btn-sm" onClick={assignToMe}>
                  {t('support.assignToMe')}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={toggleStatus}>
                  {conversation.status === 'OPEN' ? t('support.closeConversation') : t('support.reopenConversation')}
                </button>
              </div>
            </header>

            <div className="chat-messages" ref={scrollRef} data-testid="inbox-messages">
              {messages.length === 0 && <p className="small subtle center">{t('support.noMessagesYet')}</p>}
              {messages.map((message) => {
                const mine = message.authorType === 'AGENT';
                return (
                  <div key={message.id} className={`chat-msg ${mine ? 'mine' : 'theirs'}`}>
                    <span className="tiny subtle">
                      {mine ? t('chat.agentLabel') : (message.authorName ?? t('support.customerLabel'))}
                    </span>
                    <p className="small" style={{ margin: 0 }}>
                      {message.body}
                    </p>
                  </div>
                );
              })}
            </div>

            {error && <p className="form-error small" style={{ margin: 0 }}>{error}</p>}

            <form className="chat-composer" onSubmit={reply}>
              <input
                className="input"
                placeholder={t('support.replyPlaceholder')}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={4000}
                data-testid="inbox-reply-input"
              />
              <button className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} data-testid="inbox-reply-send">
                {busy ? t('support.sending') : t('support.sendReply')}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
