"""Retrieval and answering: find relevant chunks, then stream a cited answer."""

import json
import logging
import re
from collections.abc import AsyncIterator

import numpy as np

from app import gemini
from app.config import settings
from app.db import connect, new_id, now

logger = logging.getLogger(__name__)

HISTORY_MESSAGES = 6

SYSTEM_PROMPT = """\
You answer questions using only the numbered excerpts from the user's documents.
- Base every statement on the excerpts. Do not use outside knowledge.
- Cite the excerpts you use with their numbers in square brackets, like [1] or [2][3].
- If the excerpts don't contain the answer, say that you couldn't find it in the documents.
- Be concise, and use Markdown where it helps readability."""

NO_DOCUMENTS = "You don't have any processed documents yet. Upload a document first."
NOT_FOUND = (
    "I couldn't find anything about that in your documents. Try rephrasing the "
    "question, or upload a document that covers it."
)
EMPTY_ANSWER = "The model returned an empty answer. Please try again."


def search(query_vector: list[float], top_k: int, min_similarity: float) -> list[dict]:
    """Return the chunks most similar to the query, best first, as citable sources."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT c.document_id, c.page, c.text, c.embedding, d.filename"
            " FROM chunks c JOIN documents d ON d.id = c.document_id"
            " WHERE d.status = 'ready'"
        ).fetchall()
    query = np.asarray(query_vector, dtype=np.float32)
    query /= np.linalg.norm(query) or 1.0
    # Skip vectors of another size (EMBEDDING_DIMENSIONS changed since upload).
    rows = [row for row in rows if len(row["embedding"]) == query.nbytes]
    if not rows:
        return []
    matrix = np.stack([np.frombuffer(row["embedding"], dtype=np.float32) for row in rows])
    scores = matrix @ query
    sources = []
    for index in np.argsort(-scores)[:top_k]:
        score = float(scores[index])
        if score < min_similarity:
            break
        row = rows[index]
        sources.append(
            {
                "number": len(sources) + 1,
                "document_id": row["document_id"],
                "filename": row["filename"],
                "page": row["page"],
                "text": row["text"],
                "score": round(score, 3),
            }
        )
    return sources


def build_prompt(question: str, sources: list[dict]) -> str:
    excerpts = []
    for source in sources:
        label = source["filename"]
        if source["page"] is not None:
            label += f", page {source['page']}"
        excerpts.append(f"[{source['number']}] ({label})\n{source['text']}")
    return "Excerpts:\n\n" + "\n\n".join(excerpts) + f"\n\nQuestion: {question}"


def build_contents(history: list[tuple[str, str]], prompt: str) -> list[dict]:
    """Gemini wants alternating user/model turns that start with the user."""
    contents: list[dict] = []
    for role, text in [*history, ("user", prompt)]:
        role = "model" if role == "assistant" else "user"
        if not text.strip():
            continue
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"][0]["text"] += "\n\n" + text
        else:
            contents.append({"role": role, "parts": [{"text": text}]})
    while contents and contents[0]["role"] == "model":
        contents.pop(0)
    return contents


def remove_invalid_citations(text: str, source_count: int) -> str:
    """Drop [n] markers (and the space before them) that don't point at a source."""

    def keep(match: re.Match) -> str:
        return match.group(0) if 1 <= int(match.group(1)) <= source_count else ""

    return re.sub(r"[ \t]*\[(\d+)\]", keep, text)


def _event(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def _save_message(conversation_id: str, role: str, content: str, sources: list[dict]) -> str:
    message_id = new_id()
    timestamp = now()
    with connect() as conn:
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, sources, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (message_id, conversation_id, role, content, json.dumps(sources), timestamp),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?", (timestamp, conversation_id)
        )
    return message_id


def make_title(question: str, limit: int = 60) -> str:
    """The question on one line, shortened at a word boundary."""
    title = " ".join(question.split())
    if len(title) <= limit:
        return title
    cut = title[:limit].rsplit(" ", 1)[0] or title[:limit]
    return cut.rstrip(",.;:!?-") + "…"


def start_turn(question: str, conversation_id: str | None) -> tuple[str, str, list]:
    """Create the conversation if needed and return (id, title, recent history)."""
    with connect() as conn:
        row = None
        if conversation_id:
            row = conn.execute(
                "SELECT id, title FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
        if row is None:
            conversation_id, title = new_id(), make_title(question)
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (conversation_id, title, now(), now()),
            )
            history = []
        else:
            title = row["title"]
            recent = conn.execute(
                "SELECT role, content FROM messages WHERE conversation_id = ?"
                " ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (conversation_id, HISTORY_MESSAGES),
            ).fetchall()
            history = [(m["role"], m["content"]) for m in reversed(recent)]
    _save_message(conversation_id, "user", question, [])
    return conversation_id, title, history


async def answer(question: str, conversation_id: str | None) -> AsyncIterator[str]:
    """Answer a question as server-sent events.

    Events, in order: start, sources, delta (repeated), then done or error.
    """
    conversation_id, title, history = start_turn(question, conversation_id)
    yield _event({"type": "start", "conversation_id": conversation_id, "title": title})

    parts: list[str] = []
    sources: list[dict] = []
    saved = False
    try:
        with connect() as conn:
            has_documents = conn.execute(
                "SELECT 1 FROM documents WHERE status = 'ready' LIMIT 1"
            ).fetchone()
        if has_documents:
            [query_vector] = await gemini.embed([question], "RETRIEVAL_QUERY")
            sources = search(query_vector, settings.TOP_K, settings.MIN_SIMILARITY)
        yield _event({"type": "sources", "sources": sources})

        if not sources:
            content = NOT_FOUND if has_documents else NO_DOCUMENTS
            yield _event({"type": "delta", "text": content})
        else:
            contents = build_contents(history, build_prompt(question, sources))
            async for text in gemini.stream_answer(SYSTEM_PROMPT, contents):
                parts.append(text)
                yield _event({"type": "delta", "text": text})
            content = remove_invalid_citations("".join(parts), len(sources)).strip()
            content = content or EMPTY_ANSWER

        message_id = _save_message(conversation_id, "assistant", content, sources)
        saved = True
        yield _event({"type": "done", "message_id": message_id, "content": content})
    except gemini.GeminiError as exc:
        yield _event({"type": "error", "detail": str(exc)})
    except Exception:
        logger.exception("Chat failed")
        yield _event({"type": "error", "detail": "Something went wrong. Please try again."})
    finally:
        # Stopped by the user or failed mid-answer: keep what was shown.
        if not saved and parts:
            partial = "".join(parts).rstrip() + "\n\n_(stopped)_"
            _save_message(conversation_id, "assistant", partial, sources)
