import hashlib
import re

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import gemini
from app.config import settings
from app.main import app


def fake_vector(text: str) -> list[float]:
    """Bag-of-words hashing: texts that share words get similar vectors."""
    vector = np.zeros(settings.EMBEDDING_DIMENSIONS, dtype=np.float32)
    for word in re.findall(r"[a-z0-9]+", text.lower()):
        vector[int(hashlib.md5(word.encode()).hexdigest(), 16) % len(vector)] += 1.0
    return vector.tolist()


class FakeGemini:
    def __init__(self) -> None:
        self.embed_calls: list[tuple[list[str], str]] = []
        self.prompts: list[list[dict]] = []
        self.answer = ["The leave policy ", "is 16 weeks [1]", " and bogus [9]."]
        self.fail_after: int | None = None

    async def embed(self, texts: list[str], task_type: str) -> list[list[float]]:
        self.embed_calls.append((texts, task_type))
        return [fake_vector(text) for text in texts]

    async def stream_answer(self, system_prompt: str, contents: list[dict]):
        self.prompts.append(contents)
        for index, piece in enumerate(self.answer):
            if self.fail_after is not None and index == self.fail_after:
                raise gemini.GeminiError("Gemini API error (500): boom")
            yield piece


@pytest.fixture
def fake(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(settings, "MIN_SIMILARITY", 0.2)
    fake = FakeGemini()
    monkeypatch.setattr(gemini, "embed", fake.embed)
    monkeypatch.setattr(gemini, "stream_answer", fake.stream_answer)
    return fake


@pytest.fixture
def client(fake):
    with TestClient(app) as client:
        yield client
