#!/usr/bin/env python3
"""
Barcode Detector & Decoder
- Kisi bhi image se barcode dhundta hai
- Image ki size choti bari ho, barcode upar/neeche/rotate ho — sab handle karta hai
- Multiple barcodes bhi detect karta hai ek hi image mein

Requirements:
    pip install pyzbar opencv-python pillow numpy

Usage:
    python barcode_detector.py image.jpg
    python barcode_detector.py image.png --save-crop
    python barcode_detector.py image.tif --verbose
"""

import cv2
import numpy as np
from PIL import Image
from pyzbar.pyzbar import decode as pyzbar_decode
from pyzbar.pyzbar import ZBarSymbol
import sys
import os
import argparse


# ─────────────────────────────────────────────────────────────
# Helper: load image (supports jpg, png, tif, bmp, webp, etc.)
# ─────────────────────────────────────────────────────────────
def load_image(path: str) -> np.ndarray:
    """PIL se load karo (TIF bhi support karta hai jo OpenCV miss karta hai)"""
    pil_img = Image.open(path).convert("RGB")
    return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)


# ─────────────────────────────────────────────────────────────
# Helper: image ko alag-alag scales aur enhancements mein try karo
# ─────────────────────────────────────────────────────────────
def generate_variants(img: np.ndarray):
    """
    Ek image ke multiple variants banata hai taake
    choti/bari/dark/tilted barcodes bhi detect hon.
    """
    variants = []
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # 1. Original grayscale
    variants.append(("original_gray", gray))

    # 2. Contrast boost (CLAHE)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    variants.append(("clahe_enhanced", enhanced))

    # 3. Threshold (Otsu)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    variants.append(("otsu_thresh", thresh))

    # 4. Sharpening
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
    sharp = cv2.filter2D(gray, -1, kernel)
    variants.append(("sharpened", sharp))

    # 5. Scale up (choti images ke liye)
    h, w = img.shape[:2]
    if max(h, w) < 1200:
        scale = 1200 / max(h, w)
        upscaled = cv2.resize(gray, None, fx=scale, fy=scale,
                              interpolation=cv2.INTER_CUBIC)
        variants.append((f"upscaled_{scale:.1f}x", upscaled))

    # 6. Scale down (bohat bari images ke liye)
    if max(h, w) > 3000:
        downscaled = cv2.resize(gray, None, fx=0.5, fy=0.5,
                                interpolation=cv2.INTER_AREA)
        variants.append(("downscaled_0.5x", downscaled))

    return variants


# ─────────────────────────────────────────────────────────────
# Core: pyzbar se decode karo
# ─────────────────────────────────────────────────────────────
def decode_from_array(arr: np.ndarray):
    """numpy array ko PIL mein convert karke pyzbar se decode karo"""
    pil = Image.fromarray(arr)
    results = pyzbar_decode(pil)
    return results


# ─────────────────────────────────────────────────────────────
# Main detection function
# ─────────────────────────────────────────────────────────────
def _detect_barcodes_core(img: np.ndarray, verbose: bool = False):
    found_barcodes = {}  # data -> barcode dict (duplicates hatane ke liye)

    variants = generate_variants(img)

    for variant_name, arr in variants:
        if verbose:
            print(f"   🔍 Trying variant: {variant_name} ...")

        results = decode_from_array(arr)

        for r in results:
            data = r.data.decode("utf-8", errors="replace")
            btype = r.type

            key = f"{data}_{btype}"
            if key not in found_barcodes:
                # Scale coordinates back to original if needed
                pts = r.polygon
                rect = r.rect

                found_barcodes[key] = {
                    "data": data,
                    "type": btype,
                    "rect": rect,
                    "polygon": pts,
                    "detected_in": variant_name,
                }

                if verbose:
                    print(f"   ✅ Barcode mila [{variant_name}]: {btype} = {data}")

        if found_barcodes:
            # Ek baar milne ke baad bhi baaki variants check karo
            # (multiple barcodes ho sakti hain)
            pass

    return list(found_barcodes.values())


def detect_barcodes_from_array(img: np.ndarray, verbose: bool = False):
    """Numpy image array se barcode detect aur decode karo."""
    return _detect_barcodes_core(img, verbose=verbose)


def detect_barcodes(image_path: str, verbose: bool = False, save_crop: bool = False):
    """
    Image se saare barcodes detect aur decode karo.
    Returns: list of dicts with barcode info
    """
    if not os.path.exists(image_path):
        print(f"[ERROR] File nahi mili: {image_path}")
        sys.exit(1)

    print(f"\n📂 Image load ho rahi hai: {image_path}")
    img = load_image(image_path)
    h, w = img.shape[:2]
    print(f"   Size: {w}x{h} pixels")
    return _detect_barcodes_core(img, verbose=verbose)


# ─────────────────────────────────────────────────────────────
# Result print + annotate
# ─────────────────────────────────────────────────────────────
def print_results(barcodes: list):
    print(f"\n{'='*55}")
    if not barcodes:
        print("❌ Koi barcode detect nahi hua.")
        print("   Tips:")
        print("   - Image clearer honi chahiye")
        print("   - 'pip install pyzbar' check karein")
        print("   - Linux pe: sudo apt install libzbar0")
    else:
        print(f"✅ {len(barcodes)} barcode(s) mili/milay!")
        print(f"{'='*55}")
        for i, bc in enumerate(barcodes, 1):
            print(f"\n  [{i}] Type    : {bc['type']}")
            print(f"      Data    : {bc['data']}")
            print(f"      Variant : {bc['detected_in']}")
            if bc['rect']:
                r = bc['rect']
                print(f"      Position: x={r.left}, y={r.top}, "
                      f"w={r.width}, h={r.height}")
    print(f"{'='*55}\n")


def save_annotated(image_path: str, barcodes: list):
    """Detected barcodes ko highlight karke image save karo"""
    img = load_image(image_path)

    for bc in barcodes:
        if bc["polygon"]:
            pts = np.array([[p.x, p.y] for p in bc["polygon"]], dtype=np.int32)
            cv2.polylines(img, [pts], isClosed=True,
                          color=(0, 255, 0), thickness=3)
            x, y = pts[0]
            label = f"{bc['type']}: {bc['data'][:30]}"
            cv2.putText(img, label, (x, y - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

    out_path = os.path.splitext(image_path)[0] + "_annotated.jpg"
    cv2.imwrite(out_path, img)
    print(f"💾 Annotated image save ho gayi: {out_path}")


# ─────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Image se barcode detect aur decode karo"
    )
    parser.add_argument("image", help="Image file ka path (jpg/png/tif/bmp etc.)")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Har variant ka detail dikhao")
    parser.add_argument("--save-crop", "-s", action="store_true",
                        help="Annotated image save karo (barcodes highlight honge)")
    args = parser.parse_args()

    barcodes = detect_barcodes(args.image, verbose=args.verbose,
                               save_crop=args.save_crop)
    print_results(barcodes)

    if args.save_crop and barcodes:
        save_annotated(args.image, barcodes)


if __name__ == "__main__":
    main()