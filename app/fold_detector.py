from pathlib import Path
from typing import Dict, List
import time

import numpy as np
import tensorflow as tf
from PIL import Image, UnidentifiedImageError

from .config import MODEL_PATH

SUPPORTED_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff",
    ".webp", ".gif", ".ico", ".ppm", ".pgm", ".pbm", ".pnm"
}

IMG_SIZE = (128, 128)
_MODEL = None


def _load_model():
    global _MODEL
    if _MODEL is None:
        _MODEL = tf.keras.models.load_model(str(MODEL_PATH))
    return _MODEL


def _load_image(image_path: str) -> np.ndarray | None:
    try:
        with Image.open(image_path) as pil_img:
            pil_img = pil_img.convert("RGB")
            pil_img = pil_img.resize(IMG_SIZE)
            img = np.array(pil_img, dtype="float32")
        return np.expand_dims(img, axis=0)
    except UnidentifiedImageError:
        return None
    except Exception:
        return None


def _predict_folded(model, image_path: str, threshold: float) -> Dict:
    img = _load_image(image_path)
    if img is None:
        return {"status": "failed", "confidence": None}

    raw = model.predict(img, verbose=0)[0][0]
    if raw > threshold:
        return {"status": "folded", "confidence": float(raw)}
    return {"status": "clear", "confidence": float(1.0 - raw)}


def scan_folder(
    folder_path: str,
    threshold: float = 0.5,
    recursive: bool = False,
    progress_cb=None,
):
    folder = Path(folder_path)
    iterator = folder.rglob("*") if recursive else folder.iterdir()
    images = [p for p in iterator if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS]
    images = sorted(images)
    total = len(images)

    if progress_cb:
        try:
            progress_cb(0, total)
        except Exception:
            pass

    model = _load_model()

    results: List[Dict] = []
    failed = 0
    folded = 0
    clear = 0

    for index, img_path in enumerate(images, start=1):
        prediction = _predict_folded(model, str(img_path), threshold)
        status = prediction["status"]
        confidence = prediction["confidence"]
        if status == "failed":
            failed += 1
        elif status == "folded":
            folded += 1
        else:
            clear += 1

        results.append({
            "filename": img_path.name,
            "path": str(img_path),
            "status": status,
            "confidence": confidence,
        })

        if progress_cb:
            try:
                progress_cb(index, total)
            except Exception:
                pass

        # Cooperatively yield to keep the desktop UI event loop responsive during long scans.
        if index % 3 == 0:
            time.sleep(0)

    return {
        "total": total,
        "processed": len(results),
        "folded": folded,
        "clear": clear,
        "failed": failed,
        "results": results,
    }
