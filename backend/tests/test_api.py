import json

from app import gemini, rag
from app.config import settings

POLICY = (
    b"Parental leave policy\n\n"
    b"Primary caregivers receive 16 weeks of paid parental leave. "
    b"Secondary caregivers receive 4 weeks of paid parental leave.\n\n"
    b"Expense reports must be submitted within 30 days."
)


def upload(client, name="policy.txt", content=POLICY):
    return client.post("/api/documents", files={"file": (name, content, "text/plain")})


def chat(client, question, conversation_id=None):
    body = {"question": question, "conversation_id": conversation_id}
    with client.stream("POST", "/api/chat", json=body) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        text = "".join(response.iter_text())
    return [json.loads(block[len("data: ") :]) for block in text.split("\n\n") if block]


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_upload_rejects_bad_files(client):
    assert upload(client, name="virus.exe").status_code == 400
    assert upload(client, content=b"").status_code == 400
    settings_limit = settings.MAX_UPLOAD_MB
    try:
        settings.MAX_UPLOAD_MB = 0
        assert upload(client).status_code == 413
    finally:
        settings.MAX_UPLOAD_MB = settings_limit
    assert client.get("/api/documents").json() == []


def test_upload_indexes_document(client, fake):
    response = upload(client)
    assert response.status_code == 201
    assert response.json()["status"] == "processing"

    [document] = client.get("/api/documents").json()
    assert document["status"] == "ready"
    assert document["chunk_count"] >= 1
    assert document["error"] is None
    assert fake.embed_calls[0][1] == "RETRIEVAL_DOCUMENT"


def test_failed_indexing_is_reported(client, monkeypatch):
    async def broken_embed(texts, task_type):
        raise gemini.GeminiError("Gemini API error (403): key invalid")

    monkeypatch.setattr(gemini, "embed", broken_embed)
    upload(client)
    [document] = client.get("/api/documents").json()
    assert document["status"] == "failed"
    assert "key invalid" in document["error"]


def test_chat_streams_cited_answer(client, fake):
    upload(client)
    events = chat(client, "How many weeks of parental leave do primary caregivers get?")

    types = [event["type"] for event in events]
    assert types[0] == "start"
    assert types[1] == "sources"
    assert set(types[2:-1]) == {"delta"}
    assert types[-1] == "done"

    sources = events[1]["sources"]
    assert sources and sources[0]["number"] == 1
    assert sources[0]["filename"] == "policy.txt"
    assert "16 weeks" in sources[0]["text"]

    # The invalid citation [9] is removed from the saved answer.
    done = events[-1]
    assert "[1]" in done["content"] and "[9]" not in done["content"]

    # The excerpts were sent to the model with the question.
    prompt = fake.prompts[0][-1]["parts"][0]["text"]
    assert "[1] (policy.txt)" in prompt and "Question:" in prompt

    conversation_id = events[0]["conversation_id"]
    [listed] = client.get("/api/conversations").json()
    assert listed["id"] == conversation_id
    conversation = client.get(f"/api/conversations/{conversation_id}").json()
    assert [m["role"] for m in conversation["messages"]] == ["user", "assistant"]
    assert conversation["messages"][1]["content"] == done["content"]
    assert conversation["messages"][1]["sources"] == sources


def test_follow_up_includes_history(client, fake):
    upload(client)
    first = chat(client, "What is the parental leave policy?")
    conversation_id = first[0]["conversation_id"]
    chat(client, "And for secondary caregivers parental leave?", conversation_id)

    contents = fake.prompts[1]
    assert [turn["role"] for turn in contents] == ["user", "model", "user"]
    assert contents[0]["parts"][0]["text"] == "What is the parental leave policy?"
    conversation = client.get(f"/api/conversations/{conversation_id}").json()
    assert len(conversation["messages"]) == 4


def test_chat_without_documents(client, fake):
    events = chat(client, "Anything?")
    assert events[1] == {"type": "sources", "sources": []}
    assert events[-1]["content"] == rag.NO_DOCUMENTS
    assert fake.embed_calls == [] and fake.prompts == []


def test_chat_with_nothing_relevant(client, fake, monkeypatch):
    upload(client)
    monkeypatch.setattr(settings, "MIN_SIMILARITY", 0.99)
    events = chat(client, "What is the capital of France?")
    assert events[1]["sources"] == []
    assert events[-1]["content"] == rag.NOT_FOUND
    assert fake.prompts == []


def test_gemini_error_mid_answer_keeps_partial_text(client, fake):
    upload(client)
    fake.fail_after = 1
    events = chat(client, "parental leave policy?")
    assert events[-1] == {"type": "error", "detail": "Gemini API error (500): boom"}

    conversation = client.get(f"/api/conversations/{events[0]['conversation_id']}").json()
    assistant = conversation["messages"][-1]
    assert assistant["role"] == "assistant"
    assert assistant["content"].startswith("The leave policy")
    assert "(stopped)" in assistant["content"]


def test_unknown_conversation_starts_new_one(client):
    events = chat(client, "Hello?", conversation_id="does-not-exist")
    assert events[0]["conversation_id"] != "does-not-exist"


def test_delete_document_and_conversation(client):
    document_id = upload(client).json()["id"]
    events = chat(client, "parental leave?")
    conversation_id = events[0]["conversation_id"]

    assert client.delete(f"/api/documents/{document_id}").status_code == 204
    assert client.get("/api/documents").json() == []
    assert client.delete(f"/api/documents/{document_id}").status_code == 404
    # Its chunks are gone too, so nothing can be retrieved any more.
    assert chat(client, "parental leave?")[-1]["content"] == rag.NO_DOCUMENTS

    assert client.delete(f"/api/conversations/{conversation_id}").status_code == 204
    assert client.get(f"/api/conversations/{conversation_id}").status_code == 404


def test_empty_question_rejected(client):
    assert client.post("/api/chat", json={"question": ""}).status_code == 422
    assert client.post("/api/chat", json={"question": "   "}).status_code == 400
