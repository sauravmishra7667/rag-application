"use client";

import type { ConversationSummary, DocumentItem } from "@/lib/api";
import { Icon, Spinner } from "./icons";

type Props = {
  open: boolean;
  documents: DocumentItem[];
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  busy: boolean;
  uploading: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onUploadClick: () => void;
  onDeleteDocument: (id: string) => void;
};

export function Sidebar(props: Props) {
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-neutral-200 bg-neutral-50 transition-transform duration-200 md:static md:translate-x-0 dark:border-neutral-800 dark:bg-neutral-900 ${
        props.open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex h-12 shrink-0 items-center justify-between px-4">
        <span className="text-sm font-semibold tracking-tight">RAG App</span>
        <button
          onClick={props.onClose}
          aria-label="Close sidebar"
          className="-mr-1.5 rounded-md p-1.5 text-neutral-500 hover:bg-neutral-200 md:hidden dark:hover:bg-neutral-800"
        >
          <Icon name="x" />
        </button>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={props.onNewChat}
          disabled={props.busy}
          className="flex w-full items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-800"
        >
          <Icon name="plus" />
          New chat
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-label="Chats">
        <SectionTitle>Chats</SectionTitle>
        {props.conversations.length === 0 ? (
          <p className="px-2 py-1 text-sm text-neutral-500">Your chats will appear here.</p>
        ) : (
          <ul className="flex flex-col gap-px">
            {props.conversations.map((conversation) => {
              const active = conversation.id === props.activeConversationId;
              return (
                <li key={conversation.id} className="group relative">
                  <button
                    onClick={() => props.onOpenConversation(conversation.id)}
                    disabled={props.busy}
                    title={conversation.title}
                    aria-current={active ? "page" : undefined}
                    className={`w-full truncate rounded-md py-1.5 pl-2 pr-8 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60 ${
                      active
                        ? "bg-neutral-200 font-medium dark:bg-neutral-800"
                        : "text-neutral-700 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800/60"
                    }`}
                  >
                    {conversation.title}
                  </button>
                  <RowAction
                    label={`Delete chat “${conversation.title}”`}
                    disabled={props.busy}
                    onClick={() => props.onDeleteConversation(conversation.id)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <section
        className="flex max-h-[45%] min-h-0 flex-col border-t border-neutral-200 px-3 py-3 dark:border-neutral-800"
        aria-label="Documents"
      >
        <div className="mb-1 flex items-center justify-between">
          <SectionTitle>
            Documents
            {props.documents.length > 0 && (
              <span className="ml-1.5 font-normal tabular-nums">{props.documents.length}</span>
            )}
          </SectionTitle>
          <button
            onClick={props.onUploadClick}
            disabled={props.uploading}
            className="-mt-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-60 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            {props.uploading ? <Spinner /> : <Icon name="upload" className="size-3.5" />}
            {props.uploading ? "Uploading" : "Upload"}
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {props.documents.length === 0 ? (
            <p className="px-2 py-1 text-sm text-neutral-500">
              No documents yet. Upload or drop files here.
            </p>
          ) : (
            <ul className="flex flex-col gap-px">
              {props.documents.map((document) => (
                <li key={document.id} className="group relative">
                  <div className="flex gap-2.5 rounded-md py-1.5 pl-2 pr-8">
                    <FileBadge filename={document.filename} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm" title={document.filename}>
                        {document.filename}
                      </p>
                      <DocumentStatus document={document} />
                    </div>
                  </div>
                  <RowAction
                    label={`Delete ${document.filename}`}
                    onClick={() => props.onDeleteDocument(document.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1 px-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
      {children}
    </h2>
  );
}

function FileBadge({ filename }: { filename: string }) {
  const extension = filename.split(".").pop()?.toUpperCase() ?? "";
  return (
    <span className="mt-0.5 flex h-5 w-9 shrink-0 items-center justify-center rounded border border-neutral-300 text-[10px] font-semibold text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
      {extension.slice(0, 4)}
    </span>
  );
}

function DocumentStatus({ document }: { document: DocumentItem }) {
  if (document.status === "processing") {
    return (
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-neutral-500">
        <Spinner className="size-2.5" />
        Processing
      </p>
    );
  }
  if (document.status === "failed") {
    return (
      <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">
        {document.error ?? "Processing failed."}
      </p>
    );
  }
  const chunks = `${document.chunk_count} chunk${document.chunk_count === 1 ? "" : "s"}`;
  return (
    <p className="mt-0.5 text-xs text-neutral-500">
      {formatSize(document.size_bytes)} · {chunks}
    </p>
  );
}

function RowAction(props: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      title={props.label}
      className="absolute right-1 top-1.5 rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-red-600 focus-visible:opacity-100 disabled:hidden md:opacity-0 md:group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-red-400"
    >
      <Icon name="trash" className="size-3.5" />
    </button>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
