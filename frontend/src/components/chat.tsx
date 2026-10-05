"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Message } from "@/lib/api";
import { Icon, StopIcon } from "./icons";
import { MessageView } from "./message";

type Props = {
  messages: Message[];
  streaming: boolean;
  readyDocuments: number;
  processingDocuments: number;
  onSend: (question: string) => void;
  onStop: () => void;
  onUploadClick: () => void;
};

const MAX_TEXTAREA_HEIGHT = 200;

export function Chat(props: Props) {
  const { messages, streaming } = props;
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Follow new text only while the reader is at the bottom.
  const stickToBottom = useRef(true);

  // A different conversation was opened: start at its end.
  const firstMessageId = messages[0]?.id;
  useEffect(() => {
    stickToBottom.current = true;
  }, [firstMessageId]);

  useEffect(() => {
    const element = scroller.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  // Grow the textarea with its content, up to a limit.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [draft]);

  function submit() {
    const question = draft.trim();
    if (!question || streaming) return;
    setDraft("");
    stickToBottom.current = true;
    props.onSend(question);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {messages.length === 0 ? (
          <EmptyState {...props} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8">
            {messages.map((message) => (
              <MessageView key={message.id} message={message} />
            ))}
          </div>
        )}
      </div>

      <div className="px-4 pb-4">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-neutral-300 bg-white p-2 focus-within:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-500"
        >
          <textarea
            ref={textarea}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            maxLength={4000}
            aria-label="Question"
            placeholder="Ask a question about your documents"
            className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-6 outline-none placeholder:text-neutral-400"
          />
          {streaming ? (
            <button
              type="button"
              onClick={props.onStop}
              aria-label="Stop answering"
              title="Stop"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim()}
              aria-label="Send"
              title="Send"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500"
            >
              <Icon name="arrowUp" />
            </button>
          )}
        </form>
        <p className="mx-auto mt-2 hidden max-w-3xl text-center text-xs text-neutral-500 md:block">
          Enter to send, Shift+Enter for a new line. Answers come only from your documents.
        </p>
      </div>
    </div>
  );
}

function EmptyState(props: Props) {
  const total = props.readyDocuments + props.processingDocuments;
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center px-6 text-center">
      {total === 0 ? (
        <>
          <h1 className="text-lg font-semibold">Upload a document to get started</h1>
          <p className="mt-2 text-sm leading-relaxed text-neutral-500">
            Add PDF, Word, text, Markdown or CSV files, then ask questions about them. Every
            answer links to the passages it was based on.
          </p>
          <button
            onClick={props.onUploadClick}
            className="mt-6 flex items-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            <Icon name="upload" />
            Upload files
          </button>
          <p className="mt-3 hidden text-xs text-neutral-500 md:block">
            or drop them anywhere on this page
          </p>
        </>
      ) : (
        <>
          <h1 className="text-lg font-semibold">Ask a question</h1>
          <p className="mt-2 text-sm leading-relaxed text-neutral-500">
            {props.readyDocuments === 0
              ? "Your documents are still being processed. You can ask once they're ready."
              : `Answers are based on your ${props.readyDocuments} ready document${
                  props.readyDocuments === 1 ? "" : "s"
                } and cite their sources.`}
          </p>
        </>
      )}
    </div>
  );
}
