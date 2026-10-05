"""Minimal Gemini REST client: embeddings and streamed answers."""

import asyncio
import json
from collections.abc import AsyncIterator

import httpx

from app.config import settings

BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
EMBED_BATCH_SIZE = 50
RETRY_STATUSES = {429, 500, 502, 503, 504}


class GeminiError(Exception):
    """An error with a message that is safe to show to the user."""


def _headers() -> dict[str, str]:
    if not settings.GEMINI_API_KEY:
        raise GeminiError("GEMINI_API_KEY is not set. Add it to .env and restart the backend.")
    return {"x-goog-api-key": settings.GEMINI_API_KEY}


def _error_message(response: httpx.Response) -> str:
    if response.status_code == 429:
        return "Gemini's rate limit was reached. Wait a moment and try again."
    try:
        detail = response.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        detail = response.text[:300]
    return f"Gemini API error ({response.status_code}): {detail}"


async def embed(texts: list[str], task_type: str) -> list[list[float]]:
    """Embed texts. task_type is RETRIEVAL_DOCUMENT or RETRIEVAL_QUERY."""
    model = f"models/{settings.GEMINI_EMBEDDING_MODEL}"
    url = f"{BASE_URL}/{model}:batchEmbedContents"
    headers = _headers()
    vectors: list[list[float]] = []
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            for start in range(0, len(texts), EMBED_BATCH_SIZE):
                batch = texts[start : start + EMBED_BATCH_SIZE]
                payload = {
                    "requests": [
                        {
                            "model": model,
                            "content": {"parts": [{"text": text}]},
                            "taskType": task_type,
                            "outputDimensionality": settings.EMBEDDING_DIMENSIONS,
                        }
                        for text in batch
                    ]
                }
                for attempt in range(4):
                    response = await client.post(url, json=payload, headers=headers)
                    if response.status_code in RETRY_STATUSES and attempt < 3:
                        await asyncio.sleep(2**attempt)
                        continue
                    break
                if response.status_code >= 400:
                    raise GeminiError(_error_message(response))
                embeddings = response.json().get("embeddings") or []
                if len(embeddings) != len(batch):
                    raise GeminiError("Gemini returned an unexpected number of embeddings.")
                vectors.extend(item["values"] for item in embeddings)
    except httpx.HTTPError as exc:
        raise GeminiError(f"Couldn't reach Gemini: {exc}") from exc
    return vectors


async def stream_answer(system_prompt: str, contents: list[dict]) -> AsyncIterator[str]:
    """Yield the answer text as Gemini generates it."""
    url = f"{BASE_URL}/models/{settings.GEMINI_MODEL}:streamGenerateContent"
    payload = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        # Generous, because on thinking models the limit includes thinking tokens.
        "generationConfig": {"maxOutputTokens": 8192},
    }
    headers = _headers()
    try:
        async with (
            httpx.AsyncClient(timeout=httpx.Timeout(120, connect=10)) as client,
            client.stream(
                "POST", url, params={"alt": "sse"}, json=payload, headers=headers
            ) as response,
        ):
            if response.status_code >= 400:
                await response.aread()
                raise GeminiError(_error_message(response))
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    event = json.loads(line[5:])
                except ValueError:
                    continue
                if (event.get("promptFeedback") or {}).get("blockReason"):
                    raise GeminiError("Gemini declined to answer this question.")
                for candidate in (event.get("candidates") or [])[:1]:
                    for part in (candidate.get("content") or {}).get("parts") or []:
                        if part.get("text") and not part.get("thought"):
                            yield part["text"]
    except httpx.HTTPError as exc:
        raise GeminiError(f"Couldn't reach Gemini: {exc}") from exc
