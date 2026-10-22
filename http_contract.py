"""Browser request-origin policy that also works behind a reverse proxy."""
from urllib.parse import urlsplit


def origin_tuple(value):
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            return None
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            return None
        return parsed.scheme, parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == "https" else 80)
    except (ValueError, AttributeError):
        return None


def origin_is_allowed(headers, request_host, public_origin=""):
    site = headers.get("Sec-Fetch-Site", "").lower()
    # These values describe another browser origin even if it shares a parent domain.
    if site in ("cross-site", "same-site"):
        return False
    origin = headers.get("Origin")
    if not origin:
        # Comfy's local queue clients and CLI requests normally have no Origin.
        return site in ("", "none", "same-origin")
    parsed = origin_tuple(origin)
    if parsed is None:
        return False
    if site == "same-origin":
        # Browsers set this forbidden Sec-* header before a proxy rewrites Host.
        # JavaScript on an unrelated page cannot set it to bypass this policy.
        return True
    host_origin = origin_tuple(f"{parsed[0]}://{request_host}")
    if parsed == host_origin:
        return True
    # Explicit fallback for older clients or proxies that remove Fetch Metadata.
    # Do not infer a trusted public origin from arbitrary forwarded headers.
    return bool(public_origin and parsed == origin_tuple(public_origin))
