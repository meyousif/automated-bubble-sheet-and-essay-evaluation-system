#!/usr/bin/env python3
"""
Fast Barcode + Seat Number Detector
- Pehle barcode try karta hai
- Fail ho to OCR se Seat Number padh leta hai
- Lightweight & fast

Install:
    pip install opencv-python pillow numpy pytesseract pyzbar
    
    Windows Tesseract:
    https://github.com/UB-Mannheim/tesseract/wiki

    Linux:
    sudo apt install tesseract-ocr libzbar0

Usage:
    python detector.py image.tif
    python detector.py image.png
"""

import cv2
import numpy as np
from PIL import Image
import sys
import os
import re
import shutil
from contextlib import contextmanager

# ── optional imports ──────────────────────────────────────────
try:
    import zxingcpp
    ZXING = True
except ImportError:
    ZXING = False

PYZBAR_IMPORT_ERROR = None
try:
    from pyzbar.pyzbar import decode as zbar_decode
    PYZBAR = True
except Exception as exc:
    # pyzbar can fail with OSError/FileNotFoundError when bundled zbar DLL deps are missing.
    PYZBAR_IMPORT_ERROR = exc
    PYZBAR = False

try:
    import pytesseract
    # Windows path - apna path set karein agar zarurat ho
    # pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    TESSERACT = True
except ImportError:
    TESSERACT = False

try:
    import easyocr
    EASYOCR = True
except ImportError:
    EASYOCR = False

_EASYOCR_READER = None

if TESSERACT:
    tesseract_cmd = shutil.which("tesseract")
    if tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd


@contextmanager
def suppress_native_stderr():
    try:
        stderr_fd = sys.stderr.fileno()
    except Exception:
        yield
        return

    saved_fd = os.dup(stderr_fd)
    try:
        with open(os.devnull, "w") as devnull:
            os.dup2(devnull.fileno(), stderr_fd)
            yield
    finally:
        os.dup2(saved_fd, stderr_fd)
        os.close(saved_fd)


# ─────────────────────────────────────────────────────────────
def load_gray(path):
    pil = Image.open(path).convert("L")
    return np.array(pil)


def smart_resize(gray, target_short=800):
    """Image ko fast processing ke liye resize karo"""
    h, w = gray.shape
    short = min(h, w)
    if short > target_short:
        scale = target_short / short
        gray = cv2.resize(gray, (int(w*scale), int(h*scale)),
                          interpolation=cv2.INTER_AREA)
    return gray


def get_easyocr_reader():
    global _EASYOCR_READER
    if not EASYOCR:
        return None
    if _EASYOCR_READER is None:
        _EASYOCR_READER = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _EASYOCR_READER


def _to_known_digit_set(known_seats=None):
    out = set()
    for seat in known_seats or set():
        digits = re.sub(r"\D", "", str(seat or ""))
        if 5 <= len(digits) <= 10:
            out.add(digits)
    return out


def _valid_seat_digits(value: str):
    digits = re.sub(r"\D", "", str(value or ""))
    if 5 <= len(digits) <= 10:
        return digits
    return None


def extract_best_number(text, known_seats=None):
    if not text:
        return None

    known_digits = _to_known_digit_set(known_seats)

    seat_match = re.search(r"seat\s*no\s*[:\-]?\s*([A-Z]?\s*\d{5,10})", text, re.IGNORECASE)
    if seat_match:
        seat = re.sub(r"\s+", "", seat_match.group(1))
        digits = re.search(r"\d{5,10}", seat)
        if digits:
            candidate = digits.group(0)
            if not known_digits or candidate in known_digits:
                return candidate

    numbers = re.findall(r"\b\d{5,10}\b", text)
    if numbers:
        if known_digits:
            for candidate in numbers:
                if candidate in known_digits:
                    return candidate
            return None
        # Prefer common seat lengths (6-8) first.
        numbers.sort(key=lambda n: (0 if 6 <= len(n) <= 8 else 1, abs(len(n) - 7), n))
        return numbers[0]

    return None


# ─────────────────────────────────────────────────────────────
# STEP 1: Barcode
# ─────────────────────────────────────────────────────────────
def try_barcode(gray):
    global PYZBAR

    if ZXING:
        attempts = [
            gray,
            cv2.createCLAHE(3.0, (8, 8)).apply(gray),
        ]

        if max(gray.shape) < 2000:
            attempts.append(cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC))

        for arr in attempts:
            try:
                results = zxingcpp.read_barcodes(arr)
            except Exception:
                results = []
            if results:
                r = results[0]
                data = str(r.text).strip()
                if data:
                    return {"value": data, "method": "barcode", "type": str(r.format)}

    if not PYZBAR:
        return None

    h, w = gray.shape

    # Sirf 3 quick variants try karo
    attempts = [
        gray,
        cv2.createCLAHE(3.0, (8,8)).apply(gray),
    ]

    # Agar image badi hai to upscale bhi try karo
    if max(h, w) < 2000:
        up = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        attempts.append(up)

    for arr in attempts:
        pil = Image.fromarray(arr)
        with suppress_native_stderr():
            try:
                results = zbar_decode(pil)
            except Exception:
                # Disable pyzbar for the current process if native zbar DLL loading fails.
                PYZBAR = False
                return None
        if results:
            r = results[0]
            data = r.data.decode("utf-8", errors="replace").strip()
            return {"value": data, "method": "barcode", "type": r.type}

    return None


# ─────────────────────────────────────────────────────────────
# STEP 2: Seat Number via OCR
# ─────────────────────────────────────────────────────────────
def find_seat_number_region(gray):
    """
    Seat No region dhundo:
    - 'Seat No' ya 'Seat Number' text ke neeche hota hai
    - Usually top-left area mein
    - Typically 6-10 digit number
    """
    h, w = gray.shape

    # Top 35% of image mein dhundo - seat number wahan hota hai
    top = gray[:int(h * 0.35), :]

    return top


def ocr_seat_number(gray, known_seats=None):
    if EASYOCR:
        reader = get_easyocr_reader()
        if reader is not None:
            region = find_seat_number_region(gray)
            result_texts = []
            for arr in (region, gray):
                try:
                    texts = reader.readtext(arr, detail=0, paragraph=True)
                except Exception:
                    texts = []
                if texts:
                    result_texts.extend([str(t) for t in texts])
                    joined = " ".join(result_texts)
                    number = extract_best_number(joined, known_seats=known_seats)
                    if number:
                        return {"value": number, "method": "ocr_easyocr", "type": "TEXT"}

    if not TESSERACT:
        return None

    # Top portion lo
    region = find_seat_number_region(gray)
    h, w = region.shape

    # Upscale for OCR accuracy
    scale = max(1, 1200 // max(h, w))
    if scale > 1:
        region = cv2.resize(region, None, fx=scale, fy=scale,
                            interpolation=cv2.INTER_CUBIC)

    # Clean threshold
    _, clean = cv2.threshold(region, 0, 255,
                              cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Tesseract config: digits only, PSM 6 (block of text)
    config = "--psm 6 -c tessedit_char_whitelist=0123456789SeatNonum. "

    try:
        text = pytesseract.image_to_string(Image.fromarray(clean), config=config)
    except (pytesseract.TesseractNotFoundError, FileNotFoundError, OSError):
        return None

    # Extract number after "Seat No" or standalone large number
    # Pattern: 5-12 digit number
    numbers = re.findall(r'\b\d{5,10}\b', text)
    known_digits = _to_known_digit_set(known_seats)

    if known_digits:
        for candidate in numbers:
            if candidate in known_digits:
                return {"value": candidate, "method": "ocr_seat_number", "type": "TEXT"}
        return None

    if numbers:
        numbers.sort(key=lambda n: (0 if 6 <= len(n) <= 8 else 1, abs(len(n) - 7), n))
        seat = numbers[0]
        return {"value": seat, "method": "ocr_seat_number", "type": "TEXT"}

    return None


def ocr_full_top(gray, known_seats=None):
    """Last resort: puri top strip ka OCR"""
    if EASYOCR:
        reader = get_easyocr_reader()
        if reader is not None:
            top = gray[:int(gray.shape[0] * 0.4), :]
            try:
                texts = reader.readtext(top, detail=0, paragraph=True)
            except Exception:
                texts = []
            if texts:
                joined = " ".join(str(t) for t in texts)
                number = extract_best_number(joined, known_seats=known_seats)
                if number:
                    return {"value": number, "method": "ocr_easyocr_full_top", "type": "TEXT"}

    if not TESSERACT:
        return None

    h, w = gray.shape
    top = gray[:int(h * 0.4), :]

    scale = max(1, 1500 // max(top.shape))
    if scale > 1:
        top = cv2.resize(top, None, fx=scale, fy=scale,
                         interpolation=cv2.INTER_CUBIC)

    _, clean = cv2.threshold(top, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    try:
        text = pytesseract.image_to_string(Image.fromarray(clean), config="--psm 6")
    except (pytesseract.TesseractNotFoundError, FileNotFoundError, OSError):
        return None

    numbers = re.findall(r'\b\d{5,10}\b', text)
    known_digits = _to_known_digit_set(known_seats)

    if known_digits:
        for candidate in numbers:
            if candidate in known_digits:
                return {"value": candidate, "method": "ocr_full_top", "type": "TEXT"}
        return None

    if numbers:
        numbers.sort(key=lambda n: (0 if 6 <= len(n) <= 8 else 1, abs(len(n) - 7), n))
        return {"value": numbers[0],
                "method": "ocr_full_top", "type": "TEXT"}
    return None


def detect_barcodes_from_array(img: np.ndarray, verbose: bool = False, known_seats=None):
    """Backend API: BGR/RGB numpy image se best ID detect karo.

    Returns list of dicts compatible with omr backend integration.
    """
    _ = verbose
    if img is None:
        return []

    if img.ndim == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img

    gray = smart_resize(gray, target_short=900)
    known_digits = _to_known_digit_set(known_seats)

    result = None
    if PYZBAR or ZXING:
        result = try_barcode(gray)
        if result:
            raw = str(result.get("value") or "")
            digits = _valid_seat_digits(raw)
            if known_digits:
                if not digits or digits not in known_digits:
                    result = None
                else:
                    result["value"] = digits
            elif digits:
                result["value"] = digits
            else:
                result = None
    if not result:
        result = ocr_seat_number(gray, known_seats=known_seats)
    if not result:
        result = ocr_full_top(gray, known_seats=known_seats)

    if not result:
        return []

    return [{
        "data": str(result.get("value") or "").strip(),
        "type": str(result.get("type") or "UNKNOWN"),
        "method": str(result.get("method") or ""),
    }]


# ─────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────
def process_image(path):
    if not os.path.exists(path):
        print(f"[ERROR] File nahi mili: {path}")
        return

    print(f"\n📂 {os.path.basename(path)}")

    gray = load_gray(path)
    h, w = gray.shape
    print(f"   Size: {w}x{h}")

    result = None

    # ── Try 1: Barcode ────────────────────────────────────────
    if PYZBAR or ZXING:
        print("   🔍 Barcode scan...", end=" ", flush=True)
        result = try_barcode(gray)
        if result:
            print("✅ MILA!")
        else:
            print("❌")
    else:
        print("   ⚠️  barcode library nahi hai - barcode skip")

    # ── Try 2: OCR Seat Number ────────────────────────────────
    if not result and TESSERACT:
        print("   🔍 Seat Number OCR...", end=" ", flush=True)
        result = ocr_seat_number(gray)
        if result:
            print("✅ MILA!")
        else:
            print("❌")

    # ── Try 3: OCR Full Top ───────────────────────────────────
    if not result and TESSERACT:
        print("   🔍 Full top OCR...", end=" ", flush=True)
        result = ocr_full_top(gray)
        if result:
            print("✅ MILA!")
        else:
            print("❌")

    # ── Result ────────────────────────────────────────────────
    print(f"\n{'='*45}")
    if result:
        print(f"  ✅ ID Found!")
        print(f"     Value  : {result['value']}")
        print(f"     Method : {result['method']}")
        print(f"     Type   : {result['type']}")
    else:
        msg = []
        if not PYZBAR:
            if PYZBAR_IMPORT_ERROR:
                msg.append("pyzbar available but zbar DLL missing (install libzbar/libiconv dependencies)")
            else:
                msg.append("pip install pyzbar")
        if not TESSERACT:
            msg.append("pip install pytesseract + Tesseract install karein")
        print("  ❌ Kuch detect nahi hua.")
        if msg:
            print("  Fix: " + " | ".join(msg))
    print(f"{'='*45}\n")

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python detector.py image.jpg")
        sys.exit(1)

    process_image(sys.argv[1])