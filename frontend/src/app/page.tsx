"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Chat } from "@/components/chat";
import { Icon } from "@/components/icons";
import { Sidebar } from "@/components/sidebar";
import {
  api,
  streamChat,
  type ConversationSummary,
  type DocumentItem,
  type Message,
} from "@/lib/api";

const ACCEPTED_FILES = ".pdf,.docx,.txt,.md,.csv";

let localId = 0;
const nextLocalId = () => `local-${++localId}`;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

export default function Home() {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshDocuments = useCallback(async () => {
    try {
      setDocuments(await api.listDocuments());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await api.listConversations());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    refreshDocuments();
    refreshConversations();
    api
      .health()
      .then((health) => {
        if (!health.gemini_configured) {
          setWarning("GEMINI_API_KEY is not set on the backend, so uploads and chat will fail.");
        }
      })
      .catch(() => {
        // refreshDocuments already reports an unreachable backend.
      });
  }, [refreshDocuments, refreshConversations]);

  // Poll while any document is still being processed.
  useEffect(() => {
    if (!documents.some((document) => document.status === "processing")) return;
    const timer = setTimeout(refreshDocuments, 2000);
    return () => clearTimeout(timer);
  }, [documents, refreshDocuments]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setSidebarOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  async function upload(files: File[]) {
    setUploading(true);
    for (const file of files) {
      try {
        await api.uploadDocument(file);
      } catch (e) {
        setError(`${file.name}: ${errorText(e)}`);
      }
    }
    setUploading(false);
    refreshDocuments();
  }

  async function deleteDocument(id: string) {
    const document = documents.find((d) => d.id === id);
    if (!confirm(`Delete “${document?.filename ?? "this document"}”?`)) return;
    try {
      await api.deleteDocument(id);
    } catch (e) {
      setError(errorText(e));
    }
    refreshDocuments();
  }

  function newChat() {
    setConversationId(null);
    setMessages([]);
    setSidebarOpen(false);
  }

  async function openConversation(id: string) {
    setSidebarOpen(false);
    try {
      const conversation = await api.getConversation(id);
      setConversationId(conversation.id);
      setMessages(conversation.messages);
    } catch (e) {
      setError(errorText(e));
      refreshConversations();
    }
  }

  async function deleteConversation(id: string) {
    if (!confirm("Delete this chat?")) return;
    try {
      await api.deleteConversation(id);
      if (id === conversationId) newChat();
    } catch (e) {
      setError(errorText(e));
    }
    refreshConversations();
  }

  async function send(question: string) {
    const assistantId = nextLocalId();
    const update = (change: (message: Message) => Message) =>
      setMessages((all) => all.map((m) => (m.id === assistantId ? change(m) : m)));

    setMessages((all) => [
      ...all,
      { id: nextLocalId(), role: "user", content: question, sources: [] },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        sources: [],
        pending: true,
        searching: true,
      },
    ]);
    setStreaming(true);
    const controller = new AbortController();
    abort.current = controller;

    try {
      await streamChat(
        question,
        conversationId,
        (event) => {
          if (event.type === "start") setConversationId(event.conversation_id);
          else if (event.type === "sources")
            update((m) => ({ ...m, sources: event.sources, searching: false }));
          else if (event.type === "delta") update((m) => ({ ...m, content: m.content + event.text }));
          else if (event.type === "done") update((m) => ({ ...m, content: event.content }));
          else if (event.type === "error") update((m) => ({ ...m, error: event.detail }));
        },
        controller.signal,
      );
    } catch (e) {
      if (controller.signal.aborted) {
        update((m) => ({ ...m, content: `${m.content}\n\n_(stopped)_`.trim() }));
      } else {
        update((m) => ({ ...m, error: errorText(e) }));
      }
    } finally {
      update((m) => ({ ...m, pending: false, searching: false }));
      setStreaming(false);
      abort.current = null;
      refreshConversations();
    }
  }

  const title = conversations.find((c) => c.id === conversationId)?.title ?? "New chat";

  return (
    <div
      className="flex h-dvh overflow-hidden"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) setDragging(true);
      }}
    >
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <Sidebar
        open={sidebarOpen}
        documents={documents}
        conversations={conversations}
        activeConversationId={conversationId}
        busy={streaming}
        uploading={uploading}
        onClose={() => setSidebarOpen(false)}
        onNewChat={newChat}
        onOpenConversation={openConversation}
        onDeleteConversation={deleteConversation}
        onUploadClick={() => fileInput.current?.click()}
        onDeleteDocument={deleteDocument}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200 px-4 dark:border-neutral-800">
          <button
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
            className="-ml-1.5 rounded-md p-1.5 text-neutral-600 hover:bg-neutral-100 md:hidden dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <Icon name="menu" />
          </button>
          <h1 className="truncate text-sm font-medium">{title}</h1>
        </header>

        {(warning || error) && (
          <div className="flex flex-col gap-2 px-4 pt-3">
            {warning && (
              <p className="mx-auto w-full max-w-3xl rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                {warning}
              </p>
            )}
            {error && (
              <div
                role="alert"
                className="mx-auto flex w-full max-w-3xl items-start gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
              >
                <p className="flex-1">{error}</p>
                <button
                  onClick={() => setError(null)}
                  aria-label="Dismiss"
                  className="rounded p-0.5 hover:bg-red-100 dark:hover:bg-red-900/40"
                >
                  <Icon name="x" className="size-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        <Chat
          messages={messages}
          streaming={streaming}
          readyDocuments={documents.filter((d) => d.status === "ready").length}
          processingDocuments={documents.filter((d) => d.status === "processing").length}
          onSend={send}
          onStop={() => abort.current?.abort()}
          onUploadClick={() => fileInput.current?.click()}
        />
      </main>

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_FILES}
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) upload(files);
        }}
      />

      {dragging && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-white/90 p-6 dark:bg-neutral-950/90"
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const files = Array.from(event.dataTransfer.files);
            if (files.length) upload(files);
          }}
        >
          <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-neutral-400 text-center dark:border-neutral-600">
            <Icon name="upload" className="size-6 text-neutral-500" />
            <p className="mt-3 text-sm font-medium">Drop files to upload</p>
            <p className="mt-1 text-xs text-neutral-500">PDF, DOCX, TXT, Markdown or CSV</p>
          </div>
        </div>
      )}
    </div>
  );
}
