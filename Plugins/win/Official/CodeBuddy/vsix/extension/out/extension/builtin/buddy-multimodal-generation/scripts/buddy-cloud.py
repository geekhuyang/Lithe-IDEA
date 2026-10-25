# -*- coding: utf-8 -*-
"""
buddy-cloud - Buddy Multimodal Generation Client

Generate videos, images, 3D models, and apply video effects through
Buddy multimodal generation services. Authentication via JWT token.

Commands:
  video "prompt"                     Generate a video from text
  image "prompt"                     Generate an image from text
  3d "prompt"                        Generate a 3D model from text
  video-fx --template T --image URL  Apply video effect to image
  status <job_id> --type TYPE        Check job status

No external dependencies beyond Python stdlib + requests.
"""

import argparse
import base64 as _b64
import datetime
import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
from urllib.parse import urlparse


def _d(s: str) -> str:
    """Decode base64-encoded internal identifier."""
    return _b64.b64decode(s).decode()


# ---------------------------------------------------------------------------
# Internal configuration (not user-facing)
# ---------------------------------------------------------------------------

# Internal provider -> service mapping
_PROVIDER_MAP = {
    "video": {
        "provider": _d("dmlkZW8tZWZmZWN0"),
        "service": _d("dmNsbQ=="),
        "version": "2024-05-23",
        "submit_action": _d("U3VibWl0QWlnY1ZpZGVvSm9i"),
        "query_action": _d("RGVzY3JpYmVBaWdjVmlkZW9Kb2I="),
    },
    "image": {
        "provider": _d("aHktaW1hZ2UtdjM="),
        "service": _d("aHVueXVhbg=="),
        "version": "2023-09-01",
        "submit_action": _d("U3VibWl0SHVueXVhbkltYWdlSm9i"),
        "query_action": _d("UXVlcnlIdW55dWFuSW1hZ2VKb2I="),
    },
    "3d": {
        "provider": _d("aHktM2Q="),
        "service": _d("YWkzZA=="),
        "version": "2025-05-13",
        "submit_action": _d("U3VibWl0SHVueXVhblRvM0RQcm9Kb2I="),
        "query_action": _d("UXVlcnlIdW55dWFuVG8zRFByb0pvYg=="),
    },
    "video-fx": {
        "provider": _d("dmlkZW8tZWZmZWN0"),
        "service": _d("dmNsbQ=="),
        "version": "2024-05-23",
        "submit_action": _d("U3VibWl0VGVtcGxhdGVUb1ZpZGVvSm9i"),
        "query_action": _d("RGVzY3JpYmVUZW1wbGF0ZVRvVmlkZW9Kb2I="),
    },
}

_REGION = "ap-guangzhou"

_TCPROXY_PATH = "/agenttool/v1/tcproxy"
_FALLBACK_ENDPOINT = "https://copilot.tencent.com" + _TCPROXY_PATH


def _resolve_default_endpoint() -> str:
    """Resolve the default service endpoint from available environment sources.

    Priority:
      1. BUDDY_CLOUD_ENDPOINT env var (explicit override)
      2. ACC_PRODUCT_CONFIG_V3 env var (product config JSON with 'endpoint' field)
      3. Hardcoded fallback
    """
    # If explicit env var is set, use it directly
    explicit = os.environ.get("BUDDY_CLOUD_ENDPOINT")
    if explicit:
        return explicit

    # Try to extract endpoint from product config
    product_config_raw = os.environ.get("ACC_PRODUCT_CONFIG_V3")
    if product_config_raw:
        try:
            config = json.loads(product_config_raw)
            ep = config.get("endpoint")
            if ep:
                return ep.rstrip("/") + _TCPROXY_PATH
        except (json.JSONDecodeError, TypeError, AttributeError):
            pass

    return _FALLBACK_ENDPOINT


_DEFAULT_ENDPOINT = _resolve_default_endpoint()

# Internal signing key (hardcoded, not exposed)
_SIGNING_KEY = "codebuddy"


# ---------------------------------------------------------------------------
# Dependency helper
# ---------------------------------------------------------------------------

def _ensure_requests():
    """Auto-install requests if not available."""
    try:
        import requests as _r  # noqa: F401
        return _r
    except ImportError:
        print("[INFO] Installing required dependency...", file=sys.stderr)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "requests", "-q"],
            stdout=sys.stderr,
            stderr=sys.stderr,
        )
        print("[INFO] Dependency installed successfully.", file=sys.stderr)
        import requests as _r
        return _r


requests = _ensure_requests()


# ---------------------------------------------------------------------------
# Request signing (internal implementation detail)
# ---------------------------------------------------------------------------

def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac_sha256(key: bytes, msg: bytes) -> bytes:
    return hmac.new(key, msg, hashlib.sha256).digest()


def _sign_request(
    secret_id: str,
    secret_key: str,
    service: str,
    action: str,
    version: str,
    region: str,
    host: str,
    payload: str,
    timestamp=None,
) -> dict:
    """
    Build signed headers for an API call.
    Returns a dict of HTTP headers to include in the POST request.
    """
    if timestamp is None:
        timestamp = int(time.time())
    date = datetime.datetime.fromtimestamp(
        timestamp, tz=datetime.timezone.utc
    ).strftime("%Y-%m-%d")

    # 1. Canonical request
    http_request_method = "POST"
    canonical_uri = "/"
    canonical_querystring = ""
    content_type = "application/json; charset=utf-8"
    signed_headers = "content-type;host;x-tc-action"
    canonical_headers = (
        f"content-type:{content_type}\n"
        f"host:{host}\n"
        f"x-tc-action:{action.lower()}\n"
    )
    hashed_payload = _sha256_hex(payload.encode("utf-8"))

    canonical_request = (
        f"{http_request_method}\n"
        f"{canonical_uri}\n"
        f"{canonical_querystring}\n"
        f"{canonical_headers}\n"
        f"{signed_headers}\n"
        f"{hashed_payload}"
    )

    # 2. String to sign
    algorithm = "TC3-HMAC-SHA256"
    credential_scope = f"{date}/{service}/tc3_request"
    hashed_canonical = _sha256_hex(canonical_request.encode("utf-8"))
    string_to_sign = (
        f"{algorithm}\n"
        f"{timestamp}\n"
        f"{credential_scope}\n"
        f"{hashed_canonical}"
    )

    # 3. Signing key derivation
    secret_date = _hmac_sha256(
        (_d("VEMz") + secret_key).encode("utf-8"), date.encode("utf-8")
    )
    secret_service = _hmac_sha256(secret_date, service.encode("utf-8"))
    secret_signing = _hmac_sha256(secret_service, b"tc3_request")

    # 4. Signature
    signature = hmac.new(
        secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    # 5. Authorization header
    authorization = (
        f"{algorithm} "
        f"Credential={secret_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, "
        f"Signature={signature}"
    )

    headers = {
        "Authorization": authorization,
        "Content-Type": content_type,
        "Host": host,
        "X-TC-Action": action,
        "X-TC-Version": version,
        "X-TC-Region": region,
        "X-TC-Timestamp": str(timestamp),
    }
    return headers


# ---------------------------------------------------------------------------
# API call
# ---------------------------------------------------------------------------

def _call_api(
    endpoint: str, provider: str, service: str, version: str,
    action: str, body: dict, token: str,
) -> dict:
    """
    Call the cloud AI service through the proxy endpoint.

    Authentication uses provider-prefixed credentials internally.
    """
    secret_id = f"{provider}.{token}"
    secret_key = _SIGNING_KEY

    parsed = urlparse(endpoint)
    host = parsed.hostname

    payload = json.dumps(body, ensure_ascii=False)

    headers = _sign_request(
        secret_id=secret_id,
        secret_key=secret_key,
        service=service,
        action=action,
        version=version,
        region=_REGION,
        host=host,
        payload=payload,
    )

    print("[INFO] Submitting generation request...", file=sys.stderr)
    resp = requests.post(
        endpoint, headers=headers, data=payload.encode("utf-8"), timeout=120
    )

    try:
        result = resp.json()
    except Exception:
        _error_out({
            "error": "INVALID_RESPONSE",
            "message": f"Unexpected response (HTTP {resp.status_code}). Please try again.",
        })
        return {}

    # Unwrap response envelope
    if "Response" in result:
        inner = result["Response"]
        if "Error" in inner:
            _error_out({
                "error": "GENERATION_FAILED",
                "message": _sanitize_error_message(
                    inner["Error"].get("Message", "Request failed.")
                ),
                "request_id": inner.get("RequestId", ""),
            })
        return inner

    return result


def _sanitize_error_message(msg: str) -> str:
    """Remove any provider-specific details from error messages."""
    if not msg:
        return "Generation request failed. Please try again."
    _REDACTIONS = [
        _d("VGVuY2VudENsb3Vk"), _d("VGVuY2VudA=="),
        _d("SHVueXVhblZpZGVv"), _d("SHVueXVhbg=="), _d("aHVueXVhbg=="), _d("S2xpbmc="),
        _d("dmNsbQ=="), _d("YWkzZA=="), _d("YWlhcnQ="),
        _d("VEMz"), _d("U3VibWl0QWlnY1ZpZGVvSm9i"), _d("RGVzY3JpYmVBaWdjVmlkZW9Kb2I="),
        _d("U3VibWl0SHVueXVhbkltYWdlSm9i"), _d("UXVlcnlIdW55dWFuSW1hZ2VKb2I="),
        _d("U3VibWl0SHVueXVhblRvM0RQcm9Kb2I="), _d("UXVlcnlIdW55dWFuVG8zRFByb0pvYg=="),
        _d("U3VibWl0VGVtcGxhdGVUb1ZpZGVvSm9i"), _d("RGVzY3JpYmVUZW1wbGF0ZVRvVmlkZW9Kb2I="),
    ]
    sanitized = msg
    for term in _REDACTIONS:
        sanitized = sanitized.replace(term, "[redacted]")
    return sanitized if sanitized.strip() else "Generation request failed. Please try again."


# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------

def _poll_job(
    endpoint: str,
    provider: str,
    service: str,
    version: str,
    query_action: str,
    job_id: str,
    token: str,
    poll_interval: int,
    max_poll_time: int,
) -> dict:
    """Poll until the generation job completes or fails."""
    print(f"[INFO] Waiting for job {job_id} to complete...", file=sys.stderr)
    start_time = time.time()

    while True:
        elapsed = time.time() - start_time
        if elapsed > max_poll_time:
            _error_out({
                "error": "POLL_TIMEOUT",
                "message": f"Job did not complete within {max_poll_time}s.",
                "job_id": job_id,
            })

        result = _call_api(
            endpoint, provider, service, version,
            query_action, {"JobId": job_id}, token,
        )
        status = result.get("Status", "")
        raw_code = result.get("JobStatusCode")
        status_code = int(raw_code) if raw_code is not None else None

        if status == "DONE" or status_code == 5:
            return result
        elif status == "FAIL" or status_code == 4:
            _error_out({
                "error": "GENERATION_FAILED",
                "message": result.get("ErrorMessage", result.get("JobErrorMsg", "Generation failed.")),
                "job_id": job_id,
                "status": status or str(status_code),
            })

        display_status = status or (str(status_code) if status_code is not None else "unknown")
        print(
            f"[INFO] Job {job_id}: status={display_status}, elapsed={int(elapsed)}s, "
            f"next check in {poll_interval}s ...",
            file=sys.stderr,
        )
        time.sleep(poll_interval)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _error_out(obj: dict):
    """Print error JSON to stdout and exit 1."""
    print(json.dumps(obj, ensure_ascii=False, indent=2))
    sys.exit(1)


def _format_output(result: dict, job_id: str = None) -> dict:
    """Format API result into clean user-facing output."""
    output = {}

    if job_id:
        output["job_id"] = job_id
    elif "JobId" in result:
        output["job_id"] = result["JobId"]

    if "Status" in result:
        output["status"] = result["Status"]
    elif "JobStatusCode" in result:
        code_map = {"1": "QUEUED", "2": "PROCESSING", "4": "FAIL", "5": "DONE",
                    1: "QUEUED", 2: "PROCESSING", 4: "FAIL", 5: "DONE"}
        output["status"] = code_map.get(result["JobStatusCode"], str(result["JobStatusCode"]))

    for url_field in ("ResultUrl", "ResultVideoUrl", "ResultImage",
                      "ResultImageUrl", "ModelUrl", "ResultModelUrl"):
        if url_field in result and result[url_field]:
            val = result[url_field]
            if isinstance(val, list):
                output["result_url"] = val
            else:
                output["result_url"] = val
            break

    if "result_url" not in output:
        output["raw_result"] = result

    if "RequestId" in result:
        output["request_id"] = result["RequestId"]

    return output


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _build_parser():
    parser = argparse.ArgumentParser(
        description=(
            "Buddy Multimodal Generation - Generate videos, images, 3D models, "
            "and apply video effects."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            '  # Generate a video\n'
            '  buddy-cloud.py video "一条巨龙在夕阳下飞过山脉"\n\n'
            '  # Generate an image\n'
            '  buddy-cloud.py image "一只可爱的猫咪在花园里"\n\n'
            '  # Generate a 3D model\n'
            '  buddy-cloud.py 3d "一只小猫"\n\n'
            '  # Apply video effect to an image\n'
            '  buddy-cloud.py video-fx --template hug --image https://example.com/photo.jpg\n\n'
            '  # Check job status\n'
            '  buddy-cloud.py status abc123 --type video\n'
        ),
    )

    subparsers = parser.add_subparsers(dest="command", help="Generation command")

    p_video = subparsers.add_parser("video", help="Generate a video from text prompt")
    p_video.add_argument("prompt", help="Text description of the video to generate")
    _add_common_args(p_video)

    p_image = subparsers.add_parser("image", help="Generate an image from text prompt")
    p_image.add_argument("prompt", help="Text description of the image to generate")
    _add_common_args(p_image)

    p_3d = subparsers.add_parser("3d", help="Generate a 3D model from text prompt")
    p_3d.add_argument("prompt", help="Text description of the 3D model to generate")
    p_3d.add_argument("--model", default="3.1", choices=["3.0", "3.1"],
                       help="Model version (default: 3.1, note: 3.1 does not support LowPoly)")
    _add_common_args(p_3d)

    p_fx = subparsers.add_parser("video-fx", help="Apply video effect to an image")
    p_fx.add_argument("--template", required=True,
                       help="Effect template name (e.g., hug, kiss)")
    p_fx.add_argument("--image", required=True,
                       help="URL of the source image")
    _add_common_args(p_fx)

    p_status = subparsers.add_parser("status", help="Check job status")
    p_status.add_argument("job_id", help="Job ID to check")
    p_status.add_argument("--type", required=True,
                          choices=["video", "image", "3d", "video-fx"],
                          help="Type of the job")
    _add_common_args(p_status, include_poll=False)

    return parser


def _add_common_args(parser, include_poll=True):
    """Add common arguments shared by all subcommands."""
    parser.add_argument(
        "--token",
        default=os.getenv("BUDDY_CLOUD_TOKEN", ""),
        help="Authentication token (default: env BUDDY_CLOUD_TOKEN)",
    )
    parser.add_argument(
        "--endpoint",
        default=_DEFAULT_ENDPOINT,
        help="Service endpoint URL (auto-resolved from env or product config)",
    )
    if include_poll:
        parser.add_argument(
            "--no-poll",
            action="store_true",
            help="Submit only - don't wait for the result",
        )
        parser.add_argument(
            "--poll-interval",
            type=int,
            default=5,
            help="Seconds between status checks (default: 5)",
        )
        parser.add_argument(
            "--max-poll-time",
            type=int,
            default=600,
            help="Max seconds to wait for completion (default: 600)",
        )


def _build_video_body(prompt: str) -> dict:
    """Build video generation request body with defaults."""
    return {
        "Vendor": _d("S2xpbmc="),
        "Model": "v2.6",
        "Prompt": prompt,
        "ModelParam": json.dumps({"Duration": 5}),
        "LogoAdd": 0,
    }


def _build_image_body(prompt: str) -> dict:
    """Build image generation request body."""
    return {"Prompt": prompt}


def _build_3d_body(prompt: str, model: str = "3.1") -> dict:
    """Build 3D model generation request body."""
    return {"Prompt": prompt, "Model": model}


def _build_video_fx_body(template: str, image_url: str) -> dict:
    """Build video effects request body."""
    return {
        "Template": template,
        "Images": [{"Url": image_url}],
    }


def main():
    parser = _build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    token = args.token
    if not token:
        _error_out({
            "error": "TOKEN_NOT_CONFIGURED",
            "message": (
                "Authentication token is required. Provide via --token flag or set "
                "the BUDDY_CLOUD_TOKEN environment variable."
            ),
        })

    endpoint = args.endpoint

    if args.command == "status":
        cfg = _PROVIDER_MAP[args.type]
        result = _call_api(
            endpoint, cfg["provider"], cfg["service"], cfg["version"],
            cfg["query_action"], {"JobId": args.job_id}, token,
        )
        output = _format_output(result, job_id=args.job_id)
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    if args.command == "video":
        body = _build_video_body(args.prompt)
    elif args.command == "image":
        body = _build_image_body(args.prompt)
    elif args.command == "3d":
        body = _build_3d_body(args.prompt, args.model)
    elif args.command == "video-fx":
        body = _build_video_fx_body(args.template, args.image)
    else:
        _error_out({
            "error": "UNKNOWN_COMMAND",
            "message": f"Unknown command: {args.command}",
        })

    cfg = _PROVIDER_MAP[args.command]
    should_poll = not getattr(args, "no_poll", False)

    try:
        print(f"[INFO] Starting {args.command} generation...", file=sys.stderr)
        submit_resp = _call_api(
            endpoint, cfg["provider"], cfg["service"], cfg["version"],
            cfg["submit_action"], body, token,
        )

        job_id = submit_resp.get("JobId")
        if not job_id:
            output = _format_output(submit_resp)
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return

        print(f"[INFO] Job submitted: {job_id}", file=sys.stderr)

        if should_poll:
            result = _poll_job(
                endpoint, cfg["provider"], cfg["service"], cfg["version"],
                cfg["query_action"], job_id, token,
                args.poll_interval, args.max_poll_time,
            )
            output = _format_output(result, job_id=job_id)
            print(json.dumps(output, ensure_ascii=False, indent=2))
        else:
            output = {"job_id": job_id, "status": "SUBMITTED"}
            if "RequestId" in submit_resp:
                output["request_id"] = submit_resp["RequestId"]
            print(json.dumps(output, ensure_ascii=False, indent=2))

    except requests.exceptions.RequestException:
        _error_out({
            "error": "CONNECTION_ERROR",
            "message": "Failed to connect to the generation service. Please check your network and try again.",
        })
    except SystemExit:
        raise
    except Exception as e:
        print(f"[DEBUG] {e}", file=sys.stderr)
        _error_out({
            "error": "UNEXPECTED_ERROR",
            "message": "An unexpected error occurred. Please try again or check the logs.",
        })


if __name__ == "__main__":
    main()
