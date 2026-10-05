"""Settings, read from environment variables or a .env file."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Looks for .env in backend/ and in the project root.
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), extra="ignore")

    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.8-flash"
    GEMINI_EMBEDDING_MODEL: str = "gemini-embedding-001"
    # Changing this after uploading documents means re-uploading them.
    EMBEDDING_DIMENSIONS: int = 768

    # Where the SQLite database lives.
    DATA_DIR: Path = Path("./data")
    MAX_UPLOAD_MB: int = 25

    # Chunk size and overlap are in characters (~4 characters per token).
    CHUNK_SIZE: int = 1500
    CHUNK_OVERLAP: int = 200
    # How many passages are sent to the model, and the minimum cosine
    # similarity (0-1) a passage needs to count as relevant.
    TOP_K: int = 5
    MIN_SIMILARITY: float = 0.6

    # Comma-separated list of origins allowed to call the API.
    CORS_ORIGINS: str = "http://localhost:3000"


settings = Settings()
