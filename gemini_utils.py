import base64
import json
import mimetypes
import time
import urllib.error
import urllib.request
from pathlib import Path


GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"


def clean_response_text(text):
    if not text:
        return ""

    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.replace("```json", "").replace("```", "").strip()
    return cleaned


def text_contents(prompt):
    return [{"role": "user", "parts": [{"text": prompt}]}]


def image_contents(prompt, image_path):
    path = Path(image_path)
    mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
    image_bytes = path.read_bytes()
    encoded_image = base64.b64encode(image_bytes).decode("ascii")

    return [
        {
            "role": "user",
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": mime_type, "data": encoded_image}},
            ],
        }
    ]


def call_gemini_api(*, api_key, model, contents, retries=3, initial_delay=2.0, timeout=120):
    url = GEMINI_ENDPOINT.format(model=model, api_key=api_key)
    payload = json.dumps({"contents": contents}).encode("utf-8")
    headers = {"Content-Type": "application/json"}

    delay = initial_delay
    last_error = None

    for attempt in range(1, retries + 1):
        request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response_body = response.read().decode("utf-8")
                return json.loads(response_body)
        except urllib.error.HTTPError as exc:
            last_error = exc
            body = exc.read().decode("utf-8", errors="replace") if hasattr(exc, "read") else ""
            message = f"{exc.code} {exc.reason} {body}"
            retryable = exc.code in {429, 500, 503} or "UNAVAILABLE" in body or "Too Many Requests" in body
            if not retryable or attempt == retries:
                if exc.code == 429:
                    raise RuntimeError(
                        "Gemini API quota/rate limit reached. Use a billed key, wait for the quota window to reset, or switch to a different API key/model.\n"
                        f"Details: {message}"
                    ) from exc
                raise RuntimeError(f"Gemini API error: {message}") from exc

            time.sleep(delay)
            delay *= 2
        except urllib.error.URLError as exc:
            last_error = exc
            message = str(exc)
            if attempt == retries:
                raise RuntimeError(f"Gemini network error: {message}") from exc

            time.sleep(delay)
            delay *= 2

    raise RuntimeError(f"Gemini request failed: {last_error}")


def extract_response_text(response_json):
    try:
        candidates = response_json.get("candidates", [])
        first_candidate = candidates[0]
        content = first_candidate["content"]
        parts = content.get("parts", [])
        first_part = parts[0]
        return clean_response_text(first_part.get("text", ""))
    except (AttributeError, KeyError, IndexError, TypeError) as exc:
        raise ValueError(f"Unexpected Gemini response format: {response_json}") from exc