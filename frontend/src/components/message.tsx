"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Source } from "@/lib/api";
import { Icon, Spinner } from "./icons";

const CITATION_PREFIX = "#source-";

export function MessageView({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-neutral-100 px-4 py-2.5 text-[15px] leading-relaxed dark:bg-neutral-800">
          {message.content}
        </div>
      </div>
    );
  }
  return <AssistantMessage message={message} />;
}

function AssistantMessage({ message }: { message: Message }) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [activeSource, setActiveSource] = useState<number | null>(null);
  const sourceCount = message.sources.length;

  function cite(number: number) {
    setSourcesOpen(true);
    setActiveSource(number);
  }

  useEffect(() => {
    if (activeSource === null) return;
    document
      .getElementById(sourceElementId(message.id, activeSource))
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeSource, message.id]);

  return (
    <div className="flex flex-col gap-3">
      {message.content ? (
        <div className="markdown text-[15px] leading-relaxed">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkCitations]}
            components={{
              a: ({ href, children }) => {
                if (href?.startsWith(CITATION_PREFIX)) {
                  const number = Number(href.slice(CITATION_PREFIX.length));
                  if (number >= 1 && number <= sourceCount) {
                    return (
                      <CitationButton
                        number={number}
                        label={sourceLabel(message.sources[number - 1])}
                        onClick={() => cite(number)}
                      />
                    );
                  }
                  return <>[{children}]</>;
                }
                return (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                );
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      ) : (
        message.pending && (
          <p className="flex items-center gap-2 text-sm text-neutral-500">
            <Spinner />
            {message.searching ? "Searching your documents…" : "Writing…"}
          </p>
        )
      )}

      {message.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          {message.error}
        </p>
      )}

      {!message.pending && (message.content || sourceCount > 0) && (
        <div className="flex items-center gap-1 text-xs text-neutral-500">
          {sourceCount > 0 && (
            <button
              onClick={() => setSourcesOpen((open) => !open)}
              aria-expanded={sourcesOpen}
              className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              {sourceCount} source{sourceCount === 1 ? "" : "s"}
              <Icon
                name="chevron"
                className={`size-3.5 transition-transform ${sourcesOpen ? "rotate-180" : ""}`}
              />
            </button>
          )}
          {message.content && <CopyButton text={message.content} />}
        </div>
      )}

      {sourcesOpen && sourceCount > 0 && (
        <ol className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {message.sources.map((source) => (
            <li
              key={source.number}
              id={sourceElementId(message.id, source.number)}
              className={`scroll-mt-4 px-4 py-3 transition-colors ${
                activeSource === source.number ? "bg-neutral-100 dark:bg-neutral-800/70" : ""
              }`}
            >
              <p className="flex items-baseline gap-2 text-sm font-medium">
                <span className="citation">{source.number}</span>
                <span className="min-w-0 truncate">{source.filename}</span>
                {source.page !== null && (
                  <span className="shrink-0 font-normal text-neutral-500">page {source.page}</span>
                )}
              </p>
              <p className="mt-1.5 line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                {source.text}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CitationButton(props: { number: number; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.label}
      aria-label={`Source ${props.number}: ${props.label}`}
      className="citation hover:bg-neutral-300 dark:hover:bg-neutral-600"
    >
      {props.number}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard access can be blocked (e.g. on plain-http pages); nothing to do.
    }
  }

  return (
    <button
      onClick={copy}
      className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
    >
      <Icon name={copied ? "check" : "copy"} className="size-3.5" />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function sourceLabel(source: Source | undefined): string {
  if (!source) return "";
  return source.page !== null ? `${source.filename}, page ${source.page}` : source.filename;
}

function sourceElementId(messageId: string, number: number): string {
  return `${messageId}-source-${number}`;
}

// -- remark plugin: turn "[3]" in answer text into a citation link -------------

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

function remarkCitations() {
  return (tree: MarkdownNode) => {
    replaceCitations(tree);
  };
}

function replaceCitations(node: MarkdownNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value) return splitCitations(child.value);
    // Never nest a citation link inside another link.
    if (child.type !== "link" && child.type !== "linkReference") replaceCitations(child);
    return [child];
  });
}

function splitCitations(text: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[(\d{1,3})\]/g)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push({ type: "text", value: text.slice(last, start) });
    nodes.push({
      type: "link",
      url: `${CITATION_PREFIX}${match[1]}`,
      children: [{ type: "text", value: match[1] }],
    });
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push({ type: "text", value: text.slice(last) });
  return nodes.length ? nodes : [{ type: "text", value: text }];
}
