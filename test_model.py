import os
import sys
import numpy as np
import tensorflow as tf
from pathlib import Path
from PIL import Image, UnidentifiedImageError

# ---------------------------------------------------------------------------
# Supported image extensions (Pillow handles all of these reliably)
# ---------------------------------------------------------------------------
SUPPORTED_EXTENSIONS = {
    '.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff',
    '.webp', '.gif', '.ico', '.ppm', '.pgm', '.pbm', '.pnm'
}

IMG_SIZE = (128, 128)


# ---------------------------------------------------------------------------
# Image loading
# ---------------------------------------------------------------------------
def load_and_preprocess_image(image_path: str) -> np.ndarray | None:
    """
    Load any supported image format using Pillow and return a float32 array
    ready for the model (shape: 1 x H x W x 3, values 0-255).

    Handles: JPG, PNG, BMP, TIF/TIFF (8-/16-/32-bit, RGBA, grayscale,
    various compressions), WEBP, GIF (first frame), ICO, PPM, PGM, etc.

    NOTE: Do NOT divide by 255 here — the model's first Rescaling(1./255)
    layer handles normalisation. Double-normalising breaks predictions.
    """
    try:
        with Image.open(image_path) as pil_img:
            pil_img = pil_img.convert('RGB')           # normalise to 8-bit RGB
            pil_img = pil_img.resize(IMG_SIZE)          # (width, height)
            img = np.array(pil_img, dtype='float32')    # (H, W, 3)  0-255
        return np.expand_dims(img, axis=0)              # (1, H, W, 3)
    except UnidentifiedImageError:
        print(f"  [SKIP] Not a recognised image file: {image_path}")
        return None
    except Exception as e:
        print(f"  [ERROR] Could not read {image_path}: {e}")
        return None


# ---------------------------------------------------------------------------
# Single-image prediction
# ---------------------------------------------------------------------------
def predict_image(model, image_path: str, threshold: float = 0.5):
    """
    Returns (predicted_class, confidence) or (None, None) on failure.
    class 0 = 'clear', class 1 = 'folded'
    """
    img = load_and_preprocess_image(image_path)
    if img is None:
        return None, None

    raw = model.predict(img, verbose=0)[0][0]   # sigmoid output

    if raw > threshold:
        return 'folded', float(raw)
    else:
        return 'clear', float(1.0 - raw)


# ---------------------------------------------------------------------------
# Folder scanning
# ---------------------------------------------------------------------------
def collect_images(folder_path: str, recursive: bool = False):
    """Return a sorted list of all supported image file paths in folder."""
    folder = Path(folder_path)
    image_files = []
    iterator = folder.rglob('*') if recursive else folder.iterdir()
    for p in iterator:
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS:
            image_files.append(str(p))
    return sorted(image_files)


# ---------------------------------------------------------------------------
# Main processing
# ---------------------------------------------------------------------------
def process_folder(model_path: str, folder_path: str,
                   output_file: str = None, threshold: float = 0.5,
                   recursive: bool = False):
    # ── Load model ──────────────────────────────────────────────────────────
    print(f"\nLoading model from '{model_path}' ...")
    try:
        model = tf.keras.models.load_model(model_path)
    except Exception as e:
        print(f"[ERROR] Failed to load model: {e}")
        return
    print("Model loaded successfully!\n")

    # ── Collect images ───────────────────────────────────────────────────────
    image_files = collect_images(folder_path, recursive)

    if not image_files:
        print(f"No supported image files found in '{folder_path}'")
        print(f"Supported formats: {', '.join(sorted(SUPPORTED_EXTENSIONS))}")
        return

    print(f"Found {len(image_files)} image(s)  "
          f"({'recursive' if recursive else 'top-level only'} scan)")
    print("=" * 65)

    # ── Process each image ───────────────────────────────────────────────────
    results = []
    failed  = []

    for i, image_path in enumerate(image_files, 1):
        filename = os.path.basename(image_path)
        ext      = Path(image_path).suffix.lower()
        print(f"[{i:>3}/{len(image_files)}] {filename}")

        predicted_class, confidence = predict_image(model, image_path, threshold)

        if predicted_class is not None:
            tag = "CLEAR  ✓" if predicted_class == 'clear' else "FOLDED ✗"
            print(f"         → {tag}   (confidence: {confidence:.2%})")
            results.append({
                'filename'  : filename,
                'path'      : image_path,
                'format'    : ext.lstrip('.').upper(),
                'class'     : predicted_class,
                'confidence': confidence,
            })
        else:
            print(f"         → [FAILED] Could not process image")
            failed.append(filename)

    # ── Summary ──────────────────────────────────────────────────────────────
    clear_results  = [r for r in results if r['class'] == 'clear']
    folded_results = [r for r in results if r['class'] == 'folded']
    total_ok       = len(results)

    print("\n" + "=" * 65)
    print("SUMMARY")
    print("=" * 65)
    print(f"  Total found    : {len(image_files)}")
    print(f"  Processed OK   : {total_ok}")
    print(f"  Failed/skipped : {len(failed)}")
    if total_ok:
        print(f"  CLEAR          : {len(clear_results)}  "
              f"({len(clear_results)/total_ok*100:.1f}%)")
        print(f"  FOLDED         : {len(folded_results)}  "
              f"({len(folded_results)/total_ok*100:.1f}%)")

    # ── Grouped detailed results ─────────────────────────────────────────────
    if clear_results:
        print("\n" + "─" * 65)
        print(f"  CLEAR images ({len(clear_results)})")
        print("─" * 65)
        for r in clear_results:
            print(f"  {r['filename']:<38} [{r['format']:<5}]  "
                  f"confidence: {r['confidence']:.2%}")

    if folded_results:
        print("\n" + "─" * 65)
        print(f"  FOLDED images ({len(folded_results)})")
        print("─" * 65)
        for r in folded_results:
            print(f"  {r['filename']:<38} [{r['format']:<5}]  "
                  f"confidence: {r['confidence']:.2%}")

    if failed:
        print("\n" + "─" * 65)
        print(f"  FAILED / SKIPPED ({len(failed)})")
        print("─" * 65)
        for name in failed:
            print(f"  {name}")

    print("=" * 65)

    # ── Save CSV ─────────────────────────────────────────────────────────────
    if output_file and results:
        try:
            with open(output_file, 'w') as f:
                f.write("Filename,Format,Predicted Class,Confidence\n")
                for r in results:
                    f.write(f"{r['filename']},{r['format']},"
                            f"{r['class']},{r['confidence']:.4f}\n")
            print(f"\nResults saved to '{output_file}'")
        except Exception as e:
            print(f"[ERROR] Could not save CSV: {e}")

    return results


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    print("=" * 65)
    print("  CNN MODEL TESTER  –  Classify images as CLEAR or FOLDED")
    print("=" * 65)
    print(f"  Supported formats: {', '.join(sorted(SUPPORTED_EXTENSIONS))}")
    print("=" * 65)

    # Model path
    model_path = "model4_cnn.h5"
    if not os.path.exists(model_path):
        model_path = input("Model file not found. Enter path to .h5 model: ").strip().strip('"\'')

    # Folder path
    folder_path = input("\nEnter path to folder containing images: ").strip().strip('"\'')
    if not os.path.isdir(folder_path):
        print(f"[ERROR] '{folder_path}' is not a valid directory.")
        sys.exit(1)

    # Recursive?
    recursive_input = input("Scan subfolders recursively? (y/N): ").strip().lower()
    recursive = recursive_input in ('y', 'yes')

    # Threshold
    t_input = input("Confidence threshold (default 0.5, press Enter to keep): ").strip()
    try:
        threshold = float(t_input) if t_input else 0.5
        threshold = max(0.0, min(1.0, threshold))
    except ValueError:
        print("Invalid — using default threshold 0.5.")
        threshold = 0.5

    # CSV output
    csv_input = input("Save results to CSV? Enter filename (or press Enter to skip): ").strip().strip('"\'')
    output_file = csv_input if csv_input else None

    # Run
    process_folder(model_path, folder_path, output_file, threshold, recursive)


if __name__ == "__main__":
    main()