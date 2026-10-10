# The same commands CI runs (idp-platform reusable workflow), so "green locally" means
# "green in CI". Needs uv: https://docs.astral.sh/uv/
.PHONY: install check fix test run image

install:        ## create .venv from the lock file
	uv sync --locked

check:          ## everything CI checks before it builds the image
	uv run ruff check .
	uv run ruff format --check .
	uv run mypy
	uv run pytest

fix:            ## apply formatting and safe lint fixes
	uv run ruff check --fix .
	uv run ruff format .

test:
	uv run pytest

run:            ## http://localhost:8000/${{ values.name }}/docs
	uv run uvicorn app.main:app --reload --port 8000

image:
	docker build --build-arg GIT_SHA=$$(git rev-parse HEAD) -t ${{ values.name }}:local .
