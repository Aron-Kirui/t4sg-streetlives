"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Mic, X } from "lucide-react";
import moment from "moment";
import { cn } from "@/lib/utils";
import { createSession, sendMessage, fetchMessages, getSession, closeSession } from "@/lib/chatApi";
import type { Message } from "@/lib/chatApi";

type ChatState = "picker" | "waiting" | "live" | "closed";

type MessageRole = "user" | "navigator" | "system";

interface LocalMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
}

const NEED_CATEGORIES = [
  { value: "accommodations", label: "Accommodations" },
  { value: "food", label: "Food" },
  { value: "clothing", label: "Clothing" },
  { value: "personal_care", label: "Personal Care" },
  { value: "health", label: "Health" },
  { value: "family_services", label: "Family Services" },
  { value: "work", label: "Work" },
  { value: "legal", label: "Legal" },
  { value: "connection", label: "Connection" },
  { value: "other", label: "Other" },
];

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "zh", label: "Mandarin" },
  { value: "fr", label: "French" },
  { value: "ar", label: "Arabic" },
];

const POLL_MESSAGES_MS = 3000;
const POLL_STATUS_MS = 5000;

function NavigatorAvatar() {
  return (
    <div className="w-10 h-10 rounded-full bg-brand-yellow flex items-center justify-center flex-shrink-0">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 18v-1a5 5 0 0 1 5-5h8a5 5 0 0 1 5 5v1" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  );
}


// Parses message body from Matrix format "DisplayName: text" → { sender, text }
function parseMessage(body: string): { sender: string; text: string } {
  const colonIdx = body.indexOf(": ");
  if (colonIdx === -1) return { sender: "Navigator", text: body };
  return { sender: body.slice(0, colonIdx), text: body.slice(colonIdx + 2) };
}

export type ChatContentProps = {
  /** When set (e.g. home FAB), close actions dismiss the shell instead of navigating home. */
  onClose?: () => void;
};

export function ChatContent({ onClose }: ChatContentProps) {
  const router = useRouter();

  const [chatState, setChatState] = useState<ChatState>("picker");
  const [needCategory, setNeedCategory] = useState("accommodations");
  const [language, setLanguage] = useState("en");

  // Session credentials stored in localStorage for tab persistence
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);

  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [closedByUser, setClosedByUser] = useState(false);
  const [queuedReason, setQueuedReason] = useState<string | null>(null);
  const [transferRequested, setTransferRequested] = useState(false);
  const [requestingTransfer, setRequestingTransfer] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seenEventIds = useRef<Set<string>>(new Set());
  // Tracks texts sent optimistically this session so the next poll doesn't double-show them
  const pendingOptimisticTexts = useRef<Set<string>>(new Set());

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Restore session from localStorage on mount
  useEffect(() => {
    const storedId = localStorage.getItem("sl_session_id");
    const storedToken = localStorage.getItem("sl_session_token");
    const storedState = localStorage.getItem("sl_session_state") as ChatState | null;
    const storedQueuedReason = localStorage.getItem("sl_session_queued_reason");
    if (storedId && storedToken && storedState && storedState !== "closed") {
      setSessionId(storedId);
      setSessionToken(storedToken);
      setChatState(storedState);
      if (storedQueuedReason) setQueuedReason(storedQueuedReason);
      // navigator name is stored in localStorage and used when re-rendering system messages
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (statusPollRef.current) { clearInterval(statusPollRef.current); statusPollRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const appendMessages = useCallback((raw: Message[]) => {
    const newMsgs: LocalMessage[] = [];
    for (const m of raw) {
      if (seenEventIds.current.has(m.eventId)) continue;
      seenEventIds.current.add(m.eventId);
      const { sender, text } = parseMessage(m.body);
      // Skip User messages that were already shown optimistically this session
      if (sender === "User" && pendingOptimisticTexts.current.has(text)) {
        pendingOptimisticTexts.current.delete(text);
        continue;
      }
      const role: MessageRole = sender === "User" ? "user" : "navigator";
      newMsgs.push({
        id: m.eventId,
        role,
        content: text,
        timestamp: new Date(m.timestamp).toISOString(),
      });
    }
    if (newMsgs.length > 0) setMessages((prev) => [...prev, ...newMsgs]);
  }, []);

  const startMessagePolling = useCallback((id: string, token: string) => {
    if (pollRef.current) return;
    // Fetch immediately so history shows on restore, then keep polling
    fetchMessages(id, token).then(appendMessages).catch(() => {});
    pollRef.current = setInterval(async () => {
      try {
        const [msgs, session] = await Promise.all([
          fetchMessages(id, token),
          getSession(id, token),
        ]);
        if (session.status === "closed") {
          stopPolling();
          setChatState("closed");
          localStorage.setItem("sl_session_state", "closed");
          return;
        }
        appendMessages(msgs);
      } catch {
        // non-fatal, keep polling
      }
    }, POLL_MESSAGES_MS);
  }, [appendMessages, stopPolling]);

  const startStatusPolling = useCallback((id: string, token: string) => {
    if (statusPollRef.current) return;
    statusPollRef.current = setInterval(async () => {
      try {
        const session = await getSession(id, token);
        if (session.status === "active") {
          clearInterval(statusPollRef.current!);
          statusPollRef.current = null;

          let navName: string | null = null;
          if (session.assignedNavigatorId) {
            try {
              const navRes = await fetch(`/api/guest/navigators/${session.assignedNavigatorId}`);
              if (navRes.ok) {
                const navData = await navRes.json();
                navName = navData.name ?? null;
              }
            } catch { /* best effort */ }
          }
          if (navName) {
            localStorage.setItem("sl_session_navigator_name", navName);
          }

          setChatState("live");
          localStorage.setItem("sl_session_state", "live");
          localStorage.removeItem("sl_session_queued_reason");
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `You are connected with ${navName ?? "a navigator"}.`,
              timestamp: new Date().toISOString(),
            },
          ]);
          startMessagePolling(id, token);
          setTimeout(() => inputRef.current?.focus(), 100);
        } else if (session.status === "closed") {
          stopPolling();
          setChatState("closed");
          localStorage.setItem("sl_session_state", "closed");
        }
      } catch {
        // non-fatal
      }
    }, POLL_STATUS_MS);
  }, [startMessagePolling, stopPolling]);

  // Resume polling when session credentials are restored from localStorage
  useEffect(() => {
    if (!sessionId || !sessionToken) return;
    if (chatState === "live") startMessagePolling(sessionId, sessionToken);
    if (chatState === "waiting") startStatusPolling(sessionId, sessionToken);
  }, [chatState, sessionId, sessionToken, startMessagePolling, startStatusPolling]);

  const handleStartChat = async () => {
    setIsStarting(true);
    setError(null);
    try {
      // Fast routing check — runs routing without creating a session (~1-2s).
      // If no navigator is available, show the queue screen immediately rather
      // than waiting 30+ seconds for the Lambda to time out.
      const checkParams = new URLSearchParams({ needCategory });
      if (language) checkParams.set("language", language);
      const checkRes = await fetch(`/api/guest/sessions/check?${checkParams}`).catch(() => null);
      const check = checkRes?.ok ? await checkRes.json().catch(() => null) : null;

      if (check && check.hasNavigator === false) {
        const reason = "No navigators are currently available. Please try again later.";
        setChatState("waiting");
        setQueuedReason(reason);
        localStorage.setItem("sl_session_state", "waiting");
        localStorage.setItem("sl_session_queued_reason", reason);
        setIsStarting(false);
        // Fire session creation in background so it gets queued in the DB.
        // If it fails (503), update the queue message with a reload prompt.
        createSession(needCategory, language).catch(() => {
          const reloadReason = "We're having trouble right now. Please reload the page to try again.";
          setQueuedReason(reloadReason);
          localStorage.setItem("sl_session_queued_reason", reloadReason);
        });
        return;
      }

      const session = await createSession(needCategory, language);
      const { sessionId: id, sessionUserToken: token, status } = session;

      if (!id || !token) {
        setError("Session could not be started. Please try again.");
        return;
      }

      setSessionId(id);
      setSessionToken(token);
      localStorage.setItem("sl_session_id", id);
      localStorage.setItem("sl_session_token", token);

      if (status === "active") {
        const navName = session.assignedNavigatorName ?? null;
        if (navName) {
          localStorage.setItem("sl_session_navigator_name", navName);
        }
        setChatState("live");
        localStorage.setItem("sl_session_state", "live");
        setMessages([{
          id: crypto.randomUUID(),
          role: "system",
          content: `You are connected with ${navName ?? "a navigator"}.`,
          timestamp: new Date().toISOString(),
        }]);
        startMessagePolling(id, token);
        setTimeout(() => inputRef.current?.focus(), 100);
      } else {
        // unassigned — put in queue
        const reason = session.routingFailReason ?? "No available navigators";
        setChatState("waiting");
        setQueuedReason(reason);
        localStorage.setItem("sl_session_state", "waiting");
        localStorage.setItem("sl_session_queued_reason", reason);
        startStatusPolling(id, token);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.startsWith("queue:")) {
        const reason = msg.slice("queue:".length);
        setChatState("waiting");
        setQueuedReason(reason);
        localStorage.setItem("sl_session_state", "waiting");
        localStorage.setItem("sl_session_queued_reason", reason);
      } else {
        setError(msg || "Failed to start chat. Please try again.");
      }
    } finally {
      setIsStarting(false);
    }
  };

  const handleSend = async () => {
    const text = inputValue.trim();
    if (!text || chatState !== "live" || !sessionId || !sessionToken) return;
    setInputValue("");

    // Track so appendMessages can skip the echo when the poll returns it
    pendingOptimisticTexts.current.add(text);

    // Optimistic UI — show message immediately
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: text, timestamp: new Date().toISOString() },
    ]);

    try {
      await sendMessage(sessionId, sessionToken, text);
    } catch {
      // non-fatal — message shown optimistically, Matrix delivery best-effort
    }
  };

  const clearSession = () => {
    localStorage.removeItem("sl_session_id");
    localStorage.removeItem("sl_session_token");
    localStorage.removeItem("sl_session_state");
    localStorage.removeItem("sl_session_need_category");
    localStorage.removeItem("sl_session_created_at");
    localStorage.removeItem("sl_session_queued_reason");
    localStorage.removeItem("sl_session_navigator_name");
  };

  const handleLeave = () => {
    stopPolling();
    if (sessionId && sessionToken) {
      closeSession(sessionId, sessionToken).catch(() => {});
    }
    clearSession();
    setShowEndConfirm(false);
    if (onClose) { onClose(); return; }
    router.push("/");
  };

  const handleEndChat = async () => {
    stopPolling();
    if (sessionId && sessionToken) {
      await closeSession(sessionId, sessionToken).catch(() => {});
    }
    clearSession();
    setClosedByUser(true);
    setChatState("closed");
    setShowEndConfirm(false);
  };

  const handleRequestTransfer = async () => {
    if (!sessionId || !sessionToken) return;
    setRequestingTransfer(true);
    try {
      const res = await fetch(`/api/guest/sessions/${sessionId}/request-transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: sessionToken }),
      });
      if (res.ok) setTransferRequested(true);
    } catch { /* best effort */ }
    finally { setRequestingTransfer(false); }
  };

  const handleStartNewChat = () => {
    stopPolling();
    clearSession();
    window.location.reload();
  };

  const renderMessages = () =>
    messages.map((msg) => {
      if (msg.role === "system") {
        return (
          <div key={msg.id} className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-gray-200" />
            <p className="text-xs text-gray-400 whitespace-nowrap">{msg.content}</p>
            <div className="flex-1 h-px bg-gray-200" />
          </div>
        );
      }

      const ts = moment(msg.timestamp).format("h:mm A");

      if (msg.role === "user") {
        return (
          <div key={msg.id} className="flex flex-col items-end mb-3 max-w-[80%] ml-auto">
            <div className="bg-brand-yellow text-gray-900 text-sm px-4 py-2.5 rounded-md rounded-br-sm w-fit">
              {msg.content}
            </div>
            <span className="text-[10px] text-gray-400 mt-1 mr-1">{ts}</span>
          </div>
        );
      }

      return (
        <div key={msg.id} className="flex gap-3 mb-3 max-w-[80%]">
          <NavigatorAvatar />
          <div className="flex flex-col">
            <div className="bg-white text-gray-900 text-sm px-4 py-2.5 rounded-md rounded-tl-sm shadow-sm w-fit">
              {msg.content}
            </div>
            <span className="text-[10px] text-gray-400 mt-1 ml-1">{ts}</span>
          </div>
        </div>
      );
    });

  // Waiting room
  if (chatState === "waiting") {
    return (
      <div className="flex flex-col h-full bg-gray-100 w-full">
        <header className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
          <div className="w-8" />
          <span className="font-medium text-base text-gray-900">StreetLives</span>
          <button type="button" onClick={() => setShowEndConfirm(true)} className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 transition">
            END <X size={18} strokeWidth={2.5} />
          </button>
        </header>
        {showEndConfirm && (
          <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 flex-shrink-0">
            <p className="text-sm text-gray-700 flex-1">Leave the queue?</p>
            <button
              type="button"
              onClick={() => setShowEndConfirm(false)}
              className="text-xs text-gray-500 px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleLeave}
              className="text-xs font-medium text-gray-900 px-3 py-1.5 rounded-lg bg-brand-yellow hover:brightness-95 transition"
            >
              Confirm End
            </button>
          </div>
        )}
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="w-12 h-12 rounded-full border-4 border-brand-yellow border-t-transparent animate-spin" />
          <p className="text-gray-700 font-medium">You&rsquo;re in the queue</p>
          <p className="text-sm text-gray-400">
            {queuedReason?.includes("speaks")
              ? "No navigators are available in your language right now."
              : "All navigators are currently unavailable."
            }{" "}
            We&rsquo;ll connect you as soon as one becomes available. Please stay on this page.
          </p>
        </div>
      </div>
    );
  }

  if (chatState === "picker") {
    return (
      <div className="flex flex-col h-full bg-white w-full">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-shrink-0">
          <span className="font-medium text-base text-gray-900">StreetLives</span>
          <button
            type="button"
            onClick={() => (onClose ? onClose() : router.push("/"))}
            className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 transition uppercase tracking-wide"
            aria-label="Close"
          >
            Close <X size={14} strokeWidth={2.5} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto flex flex-col justify-center px-6 py-8 space-y-8">
          <div>
            <p className="text-sm font-medium text-gray-700 mb-3">What do you need help with?</p>
            <div className="flex flex-wrap gap-2.5">
              {NEED_CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setNeedCategory(c.value)}
                  className={cn(
                    "px-4 py-2 rounded-xl text-sm border transition",
                    needCategory === c.value
                      ? "bg-brand-yellow border-brand-yellow text-gray-900 font-medium"
                      : "border-gray-300 text-gray-700 hover:border-brand-yellow"
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-sm font-medium text-gray-700 mb-3">Preferred language</p>
            <div className="flex flex-wrap gap-2.5">
              {LANGUAGES.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  onClick={() => setLanguage(l.value)}
                  className={cn(
                    "px-4 py-2 rounded-xl text-sm border transition",
                    language === l.value
                      ? "bg-brand-yellow border-brand-yellow text-gray-900 font-medium"
                      : "border-gray-300 text-gray-700 hover:border-brand-yellow"
                  )}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <button
            type="button"
            onClick={handleStartChat}
            disabled={isStarting}
            className="w-full bg-brand-yellow text-gray-900 font-medium py-3.5 rounded-xl hover:brightness-95 transition disabled:opacity-60"
          >
            {isStarting ? "Connecting…" : "Start Chat"}
          </button>
        </div>
      </div>
    );
  }

  // Live chat + closed state
  return (
    <div className="relative flex flex-col h-full bg-gray-100 w-full">

      <header className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200 flex-shrink-0">
        <div className="w-8" />
        <span className="font-medium text-base text-gray-900">StreetLives</span>
        {chatState === "live" ? (
          <button type="button" onClick={() => setShowEndConfirm(true)} className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 transition">
            END <X size={18} strokeWidth={2.5} />
          </button>
        ) : (
          <div className="w-14" />
        )}
      </header>

      {showEndConfirm && (
        <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 flex-shrink-0">
          <p className="text-sm text-gray-700 flex-1">End this chat?</p>
          <button
            type="button"
            onClick={() => setShowEndConfirm(false)}
            className="text-xs text-gray-500 px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleEndChat}
            className="text-xs font-medium text-gray-900 px-3 py-1.5 rounded-lg bg-brand-yellow hover:brightness-95 transition"
          >
            Confirm End
          </button>
        </div>
      )}

      <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex-shrink-0 flex items-center justify-between gap-2">
        <p className="text-xs text-gray-400 flex-1 text-center">
          {chatState === "closed" ? (closedByUser ? "You ended this session" : "This session has ended") : "Connected with a peer navigator"}
        </p>
        {chatState === "live" && (
          transferRequested ? (
            <span className="text-[10px] text-amber-600 flex-shrink-0">Transfer requested</span>
          ) : (
            <button
              type="button"
              onClick={handleRequestTransfer}
              disabled={requestingTransfer}
              className="text-[10px] text-gray-400 hover:text-gray-600 underline underline-offset-2 flex-shrink-0 transition disabled:opacity-50"
            >
              {requestingTransfer ? "Requesting…" : "Request transfer"}
            </button>
          )
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {renderMessages()}
        <div ref={messagesEndRef} />
      </div>

      {chatState === "closed" ? (
        <div className="px-4 py-4 bg-white border-t border-gray-200 flex-shrink-0 text-center space-y-2">
          <p className="text-xs text-gray-500">
            {closedByUser
              ? "You have closed this session."
              : "Your session has been closed by the navigator."}
          </p>
          <button
            type="button"
            onClick={handleStartNewChat}
            className="inline-block bg-brand-yellow text-gray-900 text-sm font-medium px-5 py-2 rounded-md hover:brightness-95 transition"
          >
            Start New Chat
          </button>
        </div>
      ) : (
        <div className="px-4 py-3 bg-white border-t border-gray-200 flex items-center gap-3 flex-shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Type a message…"
            className="flex-1 text-sm text-gray-500 bg-transparent outline-none placeholder-gray-400"
          />
          <button type="button" aria-label="Voice input (coming soon)" className="text-gray-400">
            <Mic size={20} />
          </button>
        </div>
      )}
    </div>
  );
}
