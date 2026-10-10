# Two stages: dependencies are installed with uv from the lock file, then only the virtual
# environment and the code are copied into a clean image (no uv, no build cache).
# Base images are pinned by digest; Dependabot opens the update PRs.

FROM python:3.13-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.19@sha256:04d046b13e60d6bcec73cbc5e1cad25d680dea90c8573340950a0ac2d1aef424 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
# --locked: fail if uv.lock does not match pyproject.toml. --no-dev: no test tools in the image.
RUN uv sync --locked --no-dev


FROM python:3.13-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f
# Non-root with a fixed numeric id: the deployment sets runAsNonRoot and a read-only root
# filesystem (idp-gitops components/golden-path), so nothing here may need to write to disk.
# pip is not needed at run time and is a regular source of scanner findings.
RUN useradd --uid 10001 --no-create-home app && \
    rm -rf /usr/local/lib/python3.13/site-packages/pip* /usr/local/bin/pip*
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY app ./app
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA} \
    PATH=/app/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
USER 10001

EXPOSE 8000
# --timeout-keep-alive 75 > ALB idle timeout (60s): uvicorn must never close a
# connection the ALB still considers open (source of sporadic 502s).
# On SIGTERM uvicorn stops accepting connections and finishes the requests in flight.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "75"]
