# RAG App

Ask questions about your own documents and get answers with citations to the
passages they came from.

Upload a PDF, DOCX, TXT, Markdown or CSV file. It is split into chunks,
embedded with Gemini and stored in SQLite. When you ask a question, the most
similar chunks are sent to Gemini with your question, and the answer streams
back with numbered citations like `[1]` that you can expand to see the source.

```
Browser ──► Next.js (frontend/) ──► FastAPI (backend/) ──► SQLite (data/app.db)
                                          │
                                          └──► Gemini (embeddings + answers)
```

No Postgres, no vector database, no login: it is a single-user app.

## Quick start

You need **Python 3.11+**, **Node.js 20+** and a **Gemini API key** from
<https://aistudio.google.com/apikey>.

```bash
cp .env.example .env          # then set GEMINI_API_KEY in .env
```

**Backend** (terminal 1):

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8000
```

**Frontend** (terminal 2):

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:3000>, upload a document, and ask it something.

### With Docker instead

```bash
cp .env.example .env          # then set GEMINI_API_KEY
docker compose up --build
```

The web app is at <http://localhost:3000>. The database is kept in the `data`
volume.

## Configuration

Everything is set in `.env`. Only `GEMINI_API_KEY` is required. See
`.env.example` for the full list.

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model that writes the answers |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` | Model that embeds chunks and questions |
| `EMBEDDING_DIMENSIONS` | `768` | Vector size. Re-upload documents after changing it |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1500` / `200` | Chunk length and overlap, in characters |
| `TOP_K` | `5` | Most passages sent to the model per question |
| `MIN_SIMILARITY` | `0.6` | Passages less similar than this are ignored. Lower it if answers often say nothing was found |
| `MAX_UPLOAD_MB` | `25` | Upload size limit |
| `DATA_DIR` | `./data` | Where the SQLite database is stored |
| `CORS_ORIGINS` | `http://localhost:3000` | Web origins allowed to call the API |

The frontend reads `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`) at
build time.

## Project layout

```
backend/app/
  main.py        HTTP API (documents, conversations, chat)
  documents.py   text extraction, chunking, background indexing
  rag.py         similarity search, prompt, streamed answer
  gemini.py      Gemini REST client
  db.py          SQLite schema and connection
  config.py      settings from .env
backend/tests/   tests (fake Gemini, no network needed)
frontend/src/
  app/page.tsx   the whole UI state
  components/    sidebar.tsx, chat.tsx
  lib/api.ts     API client and stream reader
```

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/health` | Status, and whether a Gemini key is set |
| `GET` | `/api/documents` | List documents |
| `POST` | `/api/documents` | Upload (multipart field `file`); indexing runs in the background |
| `DELETE` | `/api/documents/{id}` | Delete a document and its chunks |
| `GET` | `/api/conversations` | List chats |
| `GET` | `/api/conversations/{id}` | A chat with its messages and sources |
| `DELETE` | `/api/conversations/{id}` | Delete a chat |
| `POST` | `/api/chat` | `{"question": "...", "conversation_id": null}` → server-sent events |

The chat stream sends JSON events in this order: `start` (conversation id),
`sources` (the passages given to the model), `delta` (repeated, answer text),
then `done` (final answer) or `error`. Interactive docs are at
<http://localhost:8000/docs>.

## Tests

```bash
cd backend
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```

```bash
cd frontend
npm run typecheck
npm run build
```

## Troubleshooting

- **"GEMINI_API_KEY is not set"**: add it to `.env` in the project root and
  restart the backend.
- **"Gemini API error (404) … not found"**: the model name isn't available to
  your key. Set `GEMINI_MODEL` to one listed at
  <https://ai.google.dev/gemini-api/docs/models>.
- **"No readable text was found"**: usually a scanned PDF. Run OCR on it
  first.
- **Answers keep saying nothing was found**: lower `MIN_SIMILARITY`, for
  example to `0.5`.
- **"Can't reach the backend"**: start the backend, and check that
  `NEXT_PUBLIC_API_URL` and `CORS_ORIGINS` match your URLs.
- **A document shows "Processing was interrupted"**: the backend restarted
  while it was being indexed. Delete it and upload it again.
