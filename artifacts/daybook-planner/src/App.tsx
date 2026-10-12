import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePlanDayChat, type PlannerChatInput, type PlannerChatReply } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  ArrowDown, ArrowLeft, ArrowRight, CalendarDays, Check, CheckCheck,
  Clock3, Leaf, LoaderCircle, Minus, RotateCcw, Send, Sparkles,
} from 'lucide-react';
import { format, isToday, parseISO } from 'date-fns';
import './index.css';

type TaskStatus = 'planned' | 'done' | 'not_done';
type Task = { id: string; title: string; startTime: string; endTime: string; status: TaskStatus; category?: string };
type ChatMessage = { role: 'user' | 'assistant'; content: string };
type DayRecord = { tasks: Task[]; messages: ChatMessage[]; summary: string };
type Records = Record<string, DayRecord>;

const STORE_KEY = 'daybook-planner-v1';
const FIRST_MESSAGE = 'A little room to think. Tell me what you need to make space for today, and I’ll shape it into a gentle, realistic plan.';
const STARTERS = ['Plan a focused workday', 'Make room for a slower morning'];
const queryClient = new QueryClient();

function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function readRecords(): Records {
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as Records;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function dateHeading(date: string) {
  const parsed = parseISO(`${date}T12:00:00`);
  return isToday(parsed) ? 'Today' : format(parsed, 'EEEE, MMMM d');
}

function formatTime(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  const suffix = hours >= 12 ? 'pm' : 'am';
  const display = hours % 12 || 12;
  return `${display}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function duration(start: string, end: string) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const mins = Math.max(0, eh * 60 + em - sh * 60 - sm);
  const hours = Math.floor(mins / 60);
  const remainder = mins % 60;
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ''}` : `${remainder}m`;
}

function makeEmptyDay(): DayRecord {
  return { tasks: [], messages: [{ role: 'assistant', content: FIRST_MESSAGE }], summary: '' };
}

function App() {
  const today = localDate();
  const [records, setRecords] = useState<Records>(() => readRecords());
  const [activeDate, setActiveDate] = useState(today);
  const activeDateRef = useRef(activeDate);
  activeDateRef.current = activeDate;
  const [draft, setDraft] = useState('');
  const [proposal, setProposal] = useState<PlannerChatReply['plan']>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const [toast, setToast] = useState('');
  const datePicker = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const planChat = usePlanDayChat();

  const day = records[activeDate] ?? makeEmptyDay();
  const sortedTasks = useMemo(
    () => [...day.tasks].sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [day.tasks],
  );
  const completed = day.tasks.filter((task) => task.status === 'done').length;
  const decided = day.tasks.filter((task) => task.status !== 'planned').length;
  const progress = day.tasks.length ? Math.round((completed / day.tasks.length) * 100) : 0;
  const history = useMemo(() => Object.keys(records).sort((a, b) => b.localeCompare(a)).slice(0, 8), [records]);

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(records));
      setStorageWarning('');
    } catch {
      setStorageWarning('Your browser could not save this daybook. Keep this page open and check your browser storage settings.');
    }
  }, [records]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [day.messages, planChat.isPending, activeDate]);

  useEffect(() => {
    setErrorMessage('');
  }, [activeDate]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const updateDay = (date: string, updater: (record: DayRecord) => DayRecord) => {
    setRecords((current) => ({ ...current, [date]: updater(current[date] ?? makeEmptyDay()) }));
  };

  const changeStatus = (taskId: string, status: TaskStatus) => {
    updateDay(activeDate, (record) => ({
      ...record,
      tasks: record.tasks.map((task) => task.id === taskId ? { ...task, status } : task),
    }));
  };

  const sendMessage = (message = draft) => {
    const content = message.trim();
    if (!content || planChat.isPending) return;
    const targetDate = activeDate;
    const nextMessages = [...day.messages, { role: 'user' as const, content }].slice(-16);
    setDraft('');
    setProposal(null);
    setErrorMessage('');
    updateDay(targetDate, (record) => ({ ...record, messages: nextMessages }));
    const payload: PlannerChatInput = {
      date: targetDate,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      dayStart: '08:00',
      dayEnd: '22:00',
      messages: nextMessages,
      existingTasks: sortedTasks.map(({ title, startTime, endTime, status }) => ({ title, startTime, endTime, status })),
    };
    planChat.mutate({ data: payload }, {
      onSuccess: (reply) => {
        updateDay(targetDate, (record) => ({
          ...record,
          messages: [...record.messages, { role: 'assistant' as const, content: reply.message }].slice(-32),
        }));
        if (activeDateRef.current === targetDate) setProposal(reply.plan);
      },
      onError: () => {
        if (activeDateRef.current === targetDate) {
          setErrorMessage('That didn’t go through. Your message is still here—try again in a moment.');
        }
      },
    });
  };

  const retryLastMessage = () => {
    const targetDate = activeDate;
    setErrorMessage('');
    const payload: PlannerChatInput = {
      date: targetDate,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      dayStart: '08:00',
      dayEnd: '22:00',
      messages: day.messages.slice(-16),
      existingTasks: sortedTasks.map(({ title, startTime, endTime, status }) => ({ title, startTime, endTime, status })),
    };
    planChat.mutate({ data: payload }, {
      onSuccess: (reply) => {
        updateDay(targetDate, (record) => ({
          ...record,
          messages: [...record.messages, { role: 'assistant' as const, content: reply.message }].slice(-32),
        }));
        if (activeDateRef.current === targetDate) setProposal(reply.plan);
      },
      onError: () => {
        if (activeDateRef.current === targetDate) {
          setErrorMessage('Still having trouble reaching your planner. Your conversation is saved here.');
        }
      },
    });
  };

  const applyProposal = () => {
    if (!proposal) return;
    const appliedPlan = proposal;
    const existingTasks = records[activeDate]?.tasks ?? [];
    const tasks: Task[] = appliedPlan.tasks.map((task, index) => {
      const previous = existingTasks.find(
        (existing) => existing.title.trim().toLowerCase() === task.title.trim().toLowerCase(),
      );
      return {
        ...task,
        id: previous?.id ?? `${activeDate}-${Date.now()}-${index}`,
        status: previous?.status ?? 'planned',
      };
    });
    updateDay(activeDate, (record) => ({ ...record, tasks, summary: appliedPlan.summary }));
    setProposal(null);
    setToast(`Your plan for ${dateHeading(activeDate).toLowerCase()} is ready.`);
  };

  const clearConversation = () => {
    updateDay(activeDate, (record) => ({ ...record, messages: [{ role: 'assistant', content: FIRST_MESSAGE }] }));
    setProposal(null);
    setErrorMessage('');
    setToast('A fresh conversation, with your schedule kept safe.');
  };

  const handleComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const shiftDate = (amount: number) => {
    const parsed = parseISO(`${activeDate}T12:00:00`);
    parsed.setDate(parsed.getDate() + amount);
    setActiveDate(localDate(parsed));
    setProposal(null);
  };

  return (
    <main className="shell">
      <header className="masthead">
        <div className="brand" data-testid="text-brand">
          <span className="brand-mark"><Leaf size={18} strokeWidth={2.2} /></span>
          <span>daybook</span>
        </div>
        <div className="brand-note">A little more room in your day</div>
      </header>

      {storageWarning && <div className="storage-warning" role="alert">{storageWarning}</div>}

      <div className="workspace">
        <section className="main-column" aria-label="Daily schedule">
          <div className="date-head">
            <div>
              <div className="eyebrow">{activeDate === today ? 'Your day, at your pace' : activeDate > today ? 'Looking ahead' : 'Looking back'}</div>
              <h1 className="date-title" data-testid="text-active-date">{dateHeading(activeDate)}</h1>
              <div className="date-subtitle">{format(parseISO(`${activeDate}T12:00:00`), 'MMMM yyyy')} <span aria-hidden="true">·</span> One thoughtful thing at a time.</div>
            </div>
            <div className="date-controls">
              <button className="icon-button" type="button" aria-label="Previous day" data-testid="button-previous-day" onClick={() => shiftDate(-1)}><ArrowLeft size={16} /></button>
              <button className="today-button" type="button" data-testid="button-open-date-picker" onClick={() => {
                const picker = datePicker.current;
                if (!picker) return;
                if (picker.showPicker) picker.showPicker();
                else picker.click();
              }}>
                <CalendarDays size={15} /> Pick a day
              </button>
              <input ref={datePicker} className="date-input" type="date" value={activeDate} aria-label="Choose a date" data-testid="input-date-picker" onChange={(event) => { setActiveDate(event.target.value); setProposal(null); }} />
              <button className="icon-button" type="button" aria-label="Next day" data-testid="button-next-day" onClick={() => shiftDate(1)}><ArrowRight size={16} /></button>
              {activeDate !== today && <button className="today-button" type="button" data-testid="button-go-today" onClick={() => { setActiveDate(today); setProposal(null); }}>Today</button>}
            </div>
          </div>

          <div className="summary-band" data-testid="status-daily-progress">
            <div className="summary-text">
              <strong>{day.tasks.length === 0 ? 'A day with room to begin' : completed === day.tasks.length ? 'You showed up for your whole plan' : `${completed} of ${day.tasks.length} ${day.tasks.length === 1 ? 'block' : 'blocks'} done`}</strong>
              {day.tasks.length === 0 ? 'Start with what matters. We’ll find the time together.' : decided < day.tasks.length ? `${day.tasks.length - decided} still waiting for a check-in` : 'Every block has a clear ending. Take a breath.'}
            </div>
              <div className="progress-ring" style={{ '--progress': `${progress}%` } as CSSProperties} aria-label={`${progress}% complete`}><span>{progress}%</span></div>
          </div>

          <div className="section-label">
            <h2>Your schedule</h2>
            <span>{day.tasks.length ? `${day.tasks.length} ${day.tasks.length === 1 ? 'block' : 'blocks'}` : 'Nothing pencilled in yet'}</span>
          </div>

          {sortedTasks.length ? (
            <div className="task-list" data-testid="list-schedule">
              {sortedTasks.map((task, index) => (
                <article className="task-row" key={task.id} data-testid={`card-task-${task.id}`}>
                  <time className="task-time">{formatTime(task.startTime)}</time>
                  <div className="task-node"><span /></div>
                  <div className={`task-card ${task.status === 'done' ? 'is-done' : task.status === 'not_done' ? 'is-not_done' : ''}`}>
                    <div className="task-info">
                      <h3 className="task-title">{task.title}</h3>
                      <div className="task-meta">
                        <span><Clock3 size={12} /> {formatTime(task.startTime)} – {formatTime(task.endTime)} · {duration(task.startTime, task.endTime)}</span>
                        {task.category && <span className="category">{task.category}</span>}
                      </div>
                    </div>
                    <div className="task-actions" aria-label={`Mark ${task.title}`}>
                      <button className={`status-button ${task.status === 'done' ? 'active-done' : ''}`} type="button" aria-label={`Mark ${task.title} done`} title="Done" data-testid={`button-task-done-${index}`} onClick={() => changeStatus(task.id, task.status === 'done' ? 'planned' : 'done')}><Check size={16} /></button>
                      <button className={`status-button ${task.status === 'not_done' ? 'active-missed' : ''}`} type="button" aria-label={`Mark ${task.title} not done`} title="Not done" data-testid={`button-task-not-done-${index}`} onClick={() => changeStatus(task.id, task.status === 'not_done' ? 'planned' : 'not_done')}><Minus size={16} /></button>
                      {(task.status !== 'planned') && <button className="status-button" type="button" aria-label={`Reset ${task.title} status`} title="Reset status" data-testid={`button-task-reset-${index}`} onClick={() => changeStatus(task.id, 'planned')}><RotateCcw size={14} /></button>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-schedule" data-testid="empty-schedule">
              <div className="empty-icon"><Clock3 size={20} /></div>
              <h3>Leave a little room</h3>
              <p>Your day doesn’t need to be full to be meaningful. Tell your planner what’s on your mind, and it’ll help find a kind rhythm.</p>
            </div>
          )}

          <section className="history" aria-label="Schedule history">
            <div className="history-head">
              <h3>Recent days</h3>
              <span className="brand-note">Your plans stay on this device</span>
            </div>
            {history.length ? (
              <div className="history-list">
                {history.map((date) => {
                  const record = records[date];
                  const doneCount = record.tasks.filter((task) => task.status === 'done').length;
                  return <button className={`history-day ${activeDate === date ? 'selected' : ''}`} key={date} type="button" data-testid={`button-history-${date}`} onClick={() => { setActiveDate(date); setProposal(null); }}>
                    <strong>{date === today ? 'Today' : format(parseISO(`${date}T12:00:00`), 'EEE, MMM d')}</strong>
                    <small>{record.tasks.length ? `${doneCount}/${record.tasks.length} blocks done` : 'No blocks planned'}</small>
                  </button>;
                })}
              </div>
            ) : <div className="history-list"><div className="brand-note">Your first plan will find a home here.</div></div>}
          </section>
        </section>

        <aside className="chat-panel" aria-label="Planning conversation">
          <div className="chat-top">
            <div className="chat-heading">
              <div className="chat-orb"><Sparkles size={19} /></div>
              <div><h2>Make a plan together</h2><p>A thoughtful little planning companion</p></div>
            </div>
            <p className="chat-context">For <strong>{dateHeading(activeDate).toLowerCase()}</strong> · 8:00 am – 10:00 pm<br />Tell me what matters, how much energy you have, or what your day already holds.</p>
          </div>

          <div className="chat-messages" ref={scrollRef} data-testid="list-chat-messages" aria-live="polite">
            {day.messages.map((message, index) => <div className={`message ${message.role}`} key={`${activeDate}-${index}`} data-testid={`message-${message.role}-${index}`}>{message.content}</div>)}
            {planChat.isPending && <div className="sending" data-testid="status-planner-loading"><i /><i /><i /> Finding a gentle rhythm…</div>}
          </div>

          {proposal && <div className="proposal" data-testid="card-schedule-proposal">
            <div className="proposal-label"><ArrowDown size={13} /> A schedule to consider</div>
            <h3>{proposal.summary || 'A plan for your day'}</h3>
            <p>Nothing changes until you choose to add this to your day.</p>
            <ul className="proposal-preview">
              {proposal.tasks.map((task, index) => <li key={`${task.startTime}-${index}`}><span>{task.title}</span><time>{formatTime(task.startTime)} – {formatTime(task.endTime)}</time></li>)}
            </ul>
            <button className="apply-button" type="button" data-testid="button-apply-proposal" onClick={applyProposal}><CheckCheck size={16} /> Add this schedule to the day</button>
          </div>}

          {errorMessage && <div className="chat-error" role="alert" data-testid="status-chat-error">{errorMessage} <button type="button" data-testid="button-retry-chat" onClick={retryLastMessage}>Try again</button></div>}

          <div className="chat-compose">
            {day.messages.length <= 1 && <div className="prompt-chips">
              {STARTERS.map((prompt) => <button className="prompt-chip" type="button" key={prompt} data-testid={`button-prompt-${STARTERS.indexOf(prompt)}`} onClick={() => sendMessage(prompt)}>{prompt}</button>)}
            </div>}
            <div className="compose-box">
              <textarea ref={inputRef} value={draft} maxLength={4000} rows={2} placeholder="What would make today feel good?" aria-label="Message your planner" data-testid="input-planner-message" onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKey} />
              <button className="send-button" type="button" aria-label="Send message" data-testid="button-send-message" disabled={!draft.trim() || planChat.isPending} onClick={() => sendMessage()}>{planChat.isPending ? <LoaderCircle size={17} className="spin" /> : <Send size={16} />}</button>
            </div>
            <div className="chat-footnote">Enter to send · Shift + Enter for a new line <span aria-hidden="true">·</span> <button type="button" data-testid="button-clear-chat" onClick={clearConversation}>Start fresh</button></div>
          </div>
        </aside>
      </div>
      {toast && <div className="toast-note" role="status" data-testid="status-toast">{toast}</div>}
    </main>
  );
}

function Root() {
  return <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <ErrorBoundary><App /></ErrorBoundary>
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>;
}

export default Root;
