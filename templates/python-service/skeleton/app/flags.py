"""Feature flags: ask the platform's flag service whether a feature is on for a user.

    from app.flags import is_enabled

    if await is_enabled("new-checkout", user_id=order.customer_id):
        ...new code path...

Create the flag first: Backstage -> Create -> "Add a feature flag".

A flag belongs to its service. In the flag service it is stored as "<service>.<flag>"
(here: "${{ values.name }}.new-checkout"), so two services can both have a "new-checkout"
without touching each other's. This helper adds the prefix; you use the short name.

Three rules this helper keeps, so that a flag can never take the service down:

1. It never raises. If the flag service is slow, down, or says no to us, the answer is
   `default` (False unless you pass something else). Decide what "flag service unreachable"
   should mean for your feature when you pick the default.
2. It never waits long. One attempt, a short timeout.
3. It does not ask twice. An answer is reused for a few seconds, per flag and user.

How the service proves who it is: Kubernetes mounts a short-lived token into the pod that is
valid for the flag service only (FLAG_API_TOKEN_FILE; idp-gitops components/golden-path).
There is no password or API key to configure. Outside the cluster (tests, `make run`) the
variables are not set and every flag is simply its default.
"""

import asyncio
import json
import logging
import time
import urllib.error
import urllib.request
from pathlib import Path

from app.config import get_settings

logger = logging.getLogger(__name__)

# (flag, user) -> (use until, answer). Short: a flag switched off in Backstage should be off
# in this service within seconds, without a restart.
_CACHE_SECONDS = 10.0
_cache: dict[tuple[str, str], tuple[float, bool]] = {}
# Reasons with which the flag service says "I have no real answer for this flag".
_NO_ANSWER = ("flag_not_found", "evaluation_error_fail_safe")


async def is_enabled(flag: str, user_id: str = "anonymous", *, default: bool = False) -> bool:
    """True if `flag` is on for `user_id`; `default` if it does not exist or cannot be asked."""
    settings = get_settings()
    if not settings.flag_api_url:
        return default

    key = (flag, user_id)
    now = time.monotonic()
    cached = _cache.get(key)
    if cached and cached[0] > now:
        return cached[1]

    # The standard library's HTTP client blocks, so it runs in a worker thread and the event
    # loop stays free for other requests.
    answer = await asyncio.to_thread(_ask, flag, user_id, default)
    if len(_cache) > 10_000:
        _cache.clear()
    _cache[key] = (now + _CACHE_SECONDS, answer)
    return answer


def clear_cache() -> None:
    _cache.clear()


def _ask(flag: str, user_id: str, default: bool) -> bool:
    settings = get_settings()
    try:
        headers = {"Content-Type": "application/json"}
        if settings.flag_api_token_file:
            # Read every time: Kubernetes replaces the file before the token expires.
            token = Path(settings.flag_api_token_file).read_text().strip()
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(
            settings.flag_api_url.rstrip("/") + "/evaluate",
            data=json.dumps(
                {
                    "flag_name": f"{settings.service_name}.{flag}",
                    "user_id": user_id,
                    "environment": settings.flag_environment,
                }
            ).encode(),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=settings.flag_api_timeout) as response:
            body = json.load(response)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        logger.warning("flag %s: using default %s (%s)", flag, default, exc)
        return default

    # The flag service answers "off" for a flag that does not exist. A typo or a flag nobody
    # created yet should give this call's default instead, and be visible in the logs.
    if not isinstance(body, dict) or body.get("reason") in _NO_ANSWER:
        logger.warning("flag %s: using default %s (%s)", flag, default, body)
        return default
    return bool(body.get("enabled", default))
