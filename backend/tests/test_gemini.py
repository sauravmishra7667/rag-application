"""The Gemini client against a mocked HTTP transport (no network)."""

import asyncio
import json

import httpx
import pytest

from app import gemini
from app.config import settings


@pytest.fixture
def transport(monkeypatch):
    """Route the client's requests to `handler`, recording each one."""
    state = {"handler": None, "requests": []}
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        state["requests"].append(request)
        return state["handler"](request)

    def client_factory(**kwargs):
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    async def no_sleep(_):
        return None

    monkeypatch.setattr(gemini.httpx, "AsyncClient", client_factory)
    monkeypatch.setattr(gemini.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "test-key")
    return state


def collect(iterator):
    async def run():
        return [item async for item in iterator]

    return asyncio.run(run())


def test_embed_sends_batched_requests(transport):
    def handler(request):
        body = json.loads(request.content)
        return httpx.Response(
            200, json={"embeddings": [{"values": [0.1, 0.2]}] * len(body["requests"])}
        )

    transport["handler"] = handler
    texts = [f"text {i}" for i in range(gemini.EMBED_BATCH_SIZE + 3)]
    vectors = asyncio.run(gemini.embed(texts, "RETRIEVAL_DOCUMENT"))

    assert len(vectors) == len(texts)
    assert len(transport["requests"]) == 2
    first = transport["requests"][0]
    assert first.headers["x-goog-api-key"] == "test-key"
    assert first.url.path.endswith(f"/models/{settings.GEMINI_EMBEDDING_MODEL}:batchEmbedContents")
    request = json.loads(first.content)["requests"][0]
    assert request["taskType"] == "RETRIEVAL_DOCUMENT"
    assert request["outputDimensionality"] == settings.EMBEDDING_DIMENSIONS
    assert request["content"] == {"parts": [{"text": "text 0"}]}


def test_embed_retries_rate_limits(transport):
    responses = iter(
        [httpx.Response(429), httpx.Response(200, json={"embeddings": [{"values": [1.0]}]})]
    )
    transport["handler"] = lambda request: next(responses)
    assert asyncio.run(gemini.embed(["a"], "RETRIEVAL_QUERY")) == [[1.0]]
    assert len(transport["requests"]) == 2


def test_embed_reports_api_errors(transport):
    transport["handler"] = lambda request: httpx.Response(
        400, json={"error": {"message": "API key not valid."}}
    )
    with pytest.raises(gemini.GeminiError, match=r"\(400\): API key not valid"):
        asyncio.run(gemini.embed(["a"], "RETRIEVAL_QUERY"))


def test_missing_key_is_reported(transport, monkeypatch):
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "")
    with pytest.raises(gemini.GeminiError, match="GEMINI_API_KEY is not set"):
        asyncio.run(gemini.embed(["a"], "RETRIEVAL_QUERY"))


def sse(*events):
    return "".join(f"data: {json.dumps(event)}\r\n\r\n" for event in events)


def test_stream_yields_text_and_skips_thoughts(transport):
    body = sse(
        {"candidates": [{"content": {"parts": [{"text": "thinking...", "thought": True}]}}]},
        {"candidates": [{"content": {"parts": [{"text": "Hello "}]}}]},
        {"candidates": [{"content": {"parts": [{"text": "world [1]"}]}, "finishReason": "STOP"}]},
        {"usageMetadata": {"promptTokenCount": 5}},
    )
    transport["handler"] = lambda request: httpx.Response(
        200, text=body, headers={"content-type": "text/event-stream"}
    )
    contents = [{"role": "user", "parts": [{"text": "hi"}]}]
    assert collect(gemini.stream_answer("system", contents)) == ["Hello ", "world [1]"]

    request = transport["requests"][0]
    assert request.url.path.endswith(f"/models/{settings.GEMINI_MODEL}:streamGenerateContent")
    assert request.url.params["alt"] == "sse"
    payload = json.loads(request.content)
    assert payload["systemInstruction"] == {"parts": [{"text": "system"}]}
    assert payload["contents"] == contents


def test_stream_reports_blocked_prompt(transport):
    transport["handler"] = lambda request: httpx.Response(
        200, text=sse({"promptFeedback": {"blockReason": "SAFETY"}})
    )
    with pytest.raises(gemini.GeminiError, match="declined"):
        collect(gemini.stream_answer("system", []))


def test_stream_reports_http_errors(transport):
    transport["handler"] = lambda request: httpx.Response(
        404, json={"error": {"message": "models/x is not found"}}
    )
    with pytest.raises(gemini.GeminiError, match=r"\(404\): models/x is not found"):
        collect(gemini.stream_answer("system", []))


def test_network_errors_are_reported(transport):
    def handler(request):
        raise httpx.ConnectError("no route to host")

    transport["handler"] = handler
    with pytest.raises(gemini.GeminiError, match="Couldn't reach Gemini"):
        collect(gemini.stream_answer("system", []))
