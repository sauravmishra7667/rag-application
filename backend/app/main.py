"""HTTP API. Run with: uvicorn app.main:app --reload"""

import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app import rag
from app.config import settings
from app.db import connect, init_db, new_id, now
from app.documents import SUPPORTED_EXTENSIONS, ingest

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    if not settings.GEMINI_API_KEY:
        logger.warning("GEMINI_API_KEY is not set: uploads and chat will fail until it is.")
    yield


app = FastAPI(title="RAG App", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.CORS_ORIGINS.split(",") if origin.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "gemini_configured": bool(settings.GEMINI_API_KEY)}


# -- documents ----------------------------------------------------------------


def _get_document(document_id: str) -> dict:
    with connect() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Document not found.")
    return dict(row)


@app.get("/api/documents")
def list_documents() -> list[dict]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM documents ORDER BY created_at DESC").fetchall()
    return [dict(row) for row in rows]


@app.post("/api/documents", status_code=201)
async def upload_document(file: UploadFile, background: BackgroundTasks) -> dict:
    filename = Path(file.filename or "").name
    if Path(filename).suffix.lower() not in SUPPORTED_EXTENSIONS:
        allowed = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise HTTPException(400, f"Unsupported file type. Allowed: {allowed}.")
    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    data = await file.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(413, f"File is larger than {settings.MAX_UPLOAD_MB} MB.")
    if not data:
        raise HTTPException(400, "File is empty.")

    document_id = new_id()
    with connect() as conn:
        conn.execute(
            "INSERT INTO documents (id, filename, size_bytes, status, created_at)"
            " VALUES (?, ?, ?, 'processing', ?)",
            (document_id, filename, len(data), now()),
        )
    background.add_task(ingest, document_id, filename, data)
    return _get_document(document_id)


@app.delete("/api/documents/{document_id}", status_code=204)
def delete_document(document_id: str) -> None:
    with connect() as conn:
        deleted = conn.execute("DELETE FROM documents WHERE id = ?", (document_id,)).rowcount
    if not deleted:
        raise HTTPException(404, "Document not found.")


# -- conversations ------------------------------------------------------------


@app.get("/api/conversations")
def list_conversations() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/conversations/{conversation_id}")
def get_conversation(conversation_id: str) -> dict:
    with connect() as conn:
        conversation = conn.execute(
            "SELECT id, title, updated_at FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        if conversation is None:
            raise HTTPException(404, "Conversation not found.")
        messages = conn.execute(
            "SELECT id, role, content, sources, created_at FROM messages"
            " WHERE conversation_id = ? ORDER BY created_at, rowid",
            (conversation_id,),
        ).fetchall()
    return {
        **dict(conversation),
        "messages": [{**dict(m), "sources": json.loads(m["sources"])} for m in messages],
    }


@app.delete("/api/conversations/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str) -> None:
    with connect() as conn:
        deleted = conn.execute(
            "DELETE FROM conversations WHERE id = ?", (conversation_id,)
        ).rowcount
    if not deleted:
        raise HTTPException(404, "Conversation not found.")


# -- chat ---------------------------------------------------------------------


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    conversation_id: str | None = None


@app.post("/api/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    question = request.question.strip()
    if not question:
        raise HTTPException(400, "Question is empty.")
    return StreamingResponse(
        rag.answer(question, request.conversation_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
