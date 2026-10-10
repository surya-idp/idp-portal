"""Settings, read once from environment variables (12-factor).

Add a field here, set it in idp-gitops (apps/${{ values.name }}/base/deployment.yaml, `env:`),
and read it with `get_settings()`. Secrets come the same way, through an ExternalSecret.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    service_name: str = "${{ values.name }}"
    # Set at image build time by CI (Dockerfile ARG GIT_SHA).
    git_sha: str = "unknown"
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()
