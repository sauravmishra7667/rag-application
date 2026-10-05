export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(
  /\/$/,
  "",
);

export type DocumentItem = {
  id: string;
  filename: string;
  size_bytes: number;
  status: "processing" | "ready" | "failed";
  error: string | null;
  chunk_count: number;
  created_at: string;
};

export type Source = {
  number: number;
  document_id: string;
  filename: string;
  page: number | null;
  text: string;
  score: number;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: Source[];
  // Only set in the browser while an answer is streaming or after it failed.
  pending?: boolean;
  searching?: boolean;
  error?: string;
};

export type ConversationSummary = { id: string; title: string; updated_at: string };
export type Conversation = ConversationSummary & { messages: Message[] };

export type ChatEvent =
  | { type: "start"; conversation_id: string; title: string }
  | { type: "sources"; sources: Source[] }
  | { type: "delta"; text: string }
  | { type: "done"; message_id: string; content: string }
  | { type: "error"; detail: string };

/** fetch() with readable errors. Aborts are re-thrown unchanged. */
async function call(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(API_URL + path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(`Can't reach the backend at ${API_URL}. Is it running?`);
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") detail = body.detail;
      else if (Array.isArray(body.detail) && body.detail[0]?.msg) detail = body.detail[0].msg;
    } catch {
      // Not JSON; keep the generic message.
    }
    throw new Error(detail);
  }
  return response;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await call(path, init);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const api = {
  health: () => json<{ status: string; gemini_configured: boolean }>("/api/health"),
  listDocuments: () => json<DocumentItem[]>("/api/documents"),
  uploadDocument: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return json<DocumentItem>("/api/documents", { method: "POST", body: form });
  },
  deleteDocument: (id: string) => json<void>(`/api/documents/${id}`, { method: "DELETE" }),
  listConversations: () => json<ConversationSummary[]>("/api/conversations"),
  getConversation: (id: string) => json<Conversation>(`/api/conversations/${id}`),
  deleteConversation: (id: string) =>
    json<void>(`/api/conversations/${id}`, { method: "DELETE" }),
};

/** Ask a question and call `onEvent` for each server-sent event. */
export async function streamChat(
  question: string,
  conversationId: string | null,
  onEvent: (event: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await call("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, conversation_id: conversationId }),
    signal,
  });
  if (!response.body) throw new Error("The browser doesn't support streaming responses.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) onEvent(JSON.parse(data) as ChatEvent);
    }
  }
}
