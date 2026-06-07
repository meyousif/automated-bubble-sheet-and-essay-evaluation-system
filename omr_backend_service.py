from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pandas as pd
from barcode_detector_v2 import detect_barcodes_from_array

try:
    from PIL import Image
except ImportError:
    Image = None

TOTAL_QUESTIONS = 100
OPTIONS_PER_Q = 5
OPTION_LABELS = ["A", "B", "C", "D", "E"]
COLUMNS = 4
QUESTIONS_PER_COL = 25
CONF_THRESHOLD = 0.25
_MODEL_CACHE: dict[str, Any] = {}


def _load_model(model_path: str):
    from ultralytics import YOLO

    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model not found: {model_path}")
    abs_path = str(Path(model_path).resolve())
    if abs_path in _MODEL_CACHE:
        return _MODEL_CACHE[abs_path]
    model = YOLO(model_path)
    _MODEL_CACHE[abs_path] = model
    return model


def _load_image(image_path: str) -> np.ndarray:
    img = None
    suffix = Path(image_path).suffix.lower()

    # Many scanned TIFFs use compression modes that OpenCV cannot decode reliably.
    # Load TIFF through PIL first to avoid slow OpenCV failure path.
    if suffix in {".tif", ".tiff"} and Image is not None:
        try:
            pil_img = Image.open(image_path).convert("RGB")
            img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        except Exception:
            img = None

    if img is None:
        img = cv2.imread(image_path)

    if img is None and Image is not None:
        pil_img = Image.open(image_path).convert("RGB")
        img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)

    if img is None:
        raise FileNotFoundError(f"Image not found or unreadable: {image_path}")

    if img.ndim == 2:
        img = np.stack([img, img, img], axis=-1)
    elif img.ndim == 3 and img.shape[2] == 1:
        img = np.repeat(img, 3, axis=2)
    elif img.ndim == 3 and img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

    return img


def _bubble_darkness(img_gray: np.ndarray, x1: int, y1: int, x2: int, y2: int) -> float:
    region = img_gray[y1:y2, x1:x2]
    if region.size == 0:
        return 255.0
    return float(np.mean(region))


def _resolve_answer_from_darkness(darkness_values: list[float], option_labels: list[str]) -> str:
    if not darkness_values:
        return "?"

    min_dark = float(min(darkness_values))
    max_dark = float(max(darkness_values))
    spread = max_dark - min_dark
    if spread < 10:
        return "-"

    median_dark = float(np.median(darkness_values))
    contrast = median_dark - min_dark
    if contrast < 7:
        return "-"

    tie_margin = max(4.0, contrast * 0.45)
    min_separation = max(4.0, contrast * 0.35)

    selected_indices: list[int] = []
    for idx, value in enumerate(darkness_values):
        if (value - min_dark) <= tie_margin and (median_dark - value) >= min_separation:
            selected_indices.append(idx)

    if not selected_indices:
        selected_indices = [int(np.argmin(darkness_values))]

    if len(selected_indices) >= max(4, len(option_labels)):
        return "-"

    labels = [option_labels[i] for i in sorted(set(selected_indices)) if i < len(option_labels)]
    return "/".join(labels) if labels else "?"


def _answer_from_question_block(img_gray: np.ndarray, block: dict[str, Any]) -> str:
    x1, y1, x2, y2 = block["x1"], block["y1"], block["x2"], block["y2"]
    w = max(1, x2 - x1)
    h = max(1, y2 - y1)

    y_top = y1 + int(h * 0.22)
    y_bot = y2 - int(h * 0.22)
    if y_bot <= y_top:
        y_top, y_bot = y1, y2

    x_start = x1 + int(w * 0.17)
    x_end = x2 - int(w * 0.03)
    if x_end <= x_start:
        x_start, x_end = x1, x2

    band_w = max(1, x_end - x_start)
    darkness: list[float] = []
    for i in range(OPTIONS_PER_Q):
        sx1 = x_start + int(i * band_w / OPTIONS_PER_Q)
        sx2 = x_start + int((i + 1) * band_w / OPTIONS_PER_Q)
        darkness.append(_bubble_darkness(img_gray, sx1, y_top, sx2, y_bot))

    return _resolve_answer_from_darkness(darkness, OPTION_LABELS)


def _extract_answers(img: np.ndarray, detections) -> tuple[dict[int, str], list[dict[str, Any]]]:
    img_h, img_w = img.shape[:2]
    img_gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    boxes = detections.boxes
    if boxes is None or len(boxes) == 0:
        return {}, []

    coords = boxes.xyxy.cpu().numpy()
    centers_x = (coords[:, 0] + coords[:, 2]) / 2
    centers_y = (coords[:, 1] + coords[:, 3]) / 2

    all_boxes: list[dict[str, Any]] = []
    col_edges = np.linspace(0, img_w, COLUMNS + 1)
    for i in range(len(coords)):
        b = {
            "x1": int(coords[i, 0]),
            "y1": int(coords[i, 1]),
            "x2": int(coords[i, 2]),
            "y2": int(coords[i, 3]),
            "cx": float(centers_x[i]),
            "cy": float(centers_y[i]),
        }
        for col_idx in range(COLUMNS):
            if col_edges[col_idx] <= b["cx"] < col_edges[col_idx + 1]:
                b["sheet_col"] = col_idx
                break
        else:
            b["sheet_col"] = COLUMNS - 1
        all_boxes.append(b)

    answers: dict[int, str] = {}
    ann_rows: list[dict[str, Any]] = []
    row_merge_threshold = img_h / (QUESTIONS_PER_COL * 2.5)

    for col_idx in range(COLUMNS):
        col_boxes = [b for b in all_boxes if b["sheet_col"] == col_idx]
        if not col_boxes:
            continue

        col_boxes.sort(key=lambda b: b["cy"])
        grouped_rows: list[list[dict[str, Any]]] = []
        current = [col_boxes[0]]
        for b in col_boxes[1:]:
            if abs(b["cy"] - current[-1]["cy"]) < row_merge_threshold:
                current.append(b)
            else:
                grouped_rows.append(current)
                current = [b]
        grouped_rows.append(current)

        for row_idx, row_boxes in enumerate(grouped_rows):
            q_num = col_idx * QUESTIONS_PER_COL + row_idx + 1
            if q_num > TOTAL_QUESTIONS:
                break

            row_boxes.sort(key=lambda b: b["cx"])
            if len(row_boxes) == 1:
                answer = _answer_from_question_block(img_gray, row_boxes[0])
                box = row_boxes[0]
            elif len(row_boxes) < 2:
                answer = "?"
                box = row_boxes[0]
            else:
                darkness = [
                    _bubble_darkness(img_gray, b["x1"], b["y1"], b["x2"], b["y2"]) for b in row_boxes
                ]
                labels = OPTION_LABELS[: len(darkness)]
                answer = _resolve_answer_from_darkness(darkness, labels)
                box = row_boxes[0]

            answers[q_num] = answer
            ann_rows.append({"question": q_num, "answer": answer, "box": box})

    return answers, ann_rows


def _extract_barcode_detailed(
    img: np.ndarray,
    known_seats: set[str] | None = None,
) -> tuple[str | None, list[str], str | None]:
    """Decode barcode using the standalone barcode_detector module."""

    def _norm_text(text: str) -> str:
        return str(text or "").strip()

    def _digits(text: str) -> str:
        return "".join(ch for ch in _norm_text(text) if ch.isdigit())

    known_digits = {_digits(seat) for seat in (known_seats or set()) if _digits(seat)}

    try:
        decoded = detect_barcodes_from_array(img, verbose=False, known_seats=known_seats)
    except Exception:
        return None, [], None

    candidates: list[str] = []
    normalized_candidates: list[str] = []
    for item in decoded:
        raw = _norm_text(item.get("data"))
        if not raw:
            continue
        if raw not in candidates:
            candidates.append(raw)
        normalized = _digits(raw) or raw
        if normalized not in normalized_candidates:
            normalized_candidates.append(normalized)

    if not normalized_candidates:
        return None, [], None

    if known_digits:
        for candidate in normalized_candidates:
            if candidate in known_digits:
                return candidate, normalized_candidates, "barcode_detector_v2"
        return None, normalized_candidates, None

    return normalized_candidates[0], normalized_candidates, "barcode_detector_v2"


def _extract_barcode(img: np.ndarray, known_seats: set[str] | None = None) -> str | None:
    value, _, _ = _extract_barcode_detailed(img, known_seats=known_seats)
    return value


def _draw_annotated(img: np.ndarray, ann_rows: list[dict[str, Any]], output_path: str) -> None:
    result_img = img.copy()
    for row in ann_rows:
        box = row["box"]
        ans = row["answer"]
        q_num = row["question"]
        color = (0, 200, 0) if ans not in ("?", "-") else (0, 165, 255)
        cv2.rectangle(result_img, (box["x1"], box["y1"]), (box["x2"], box["y2"]), color, 2)
        cv2.putText(
            result_img,
            f"Q{q_num}:{ans}",
            (box["x1"], max(15, box["y1"] - 4)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            color,
            1,
            cv2.LINE_AA,
        )
    cv2.imwrite(output_path, result_img)


def _normalize_answer(value: Any) -> str:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "-"
    text = str(value).strip().upper()
    if text in ("", "-", "NAN", "NONE", "NULL"):
        return "-"
    letters = re.findall(r"[A-E]", text)
    if not letters:
        return "-"
    unique_letters: list[str] = []
    for ch in letters:
        if ch not in unique_letters:
            unique_letters.append(ch)
    return "/".join(unique_letters)


def _load_key_map(key_path: str | None) -> dict[int, str] | None:
    if not key_path:
        return None
    if not os.path.exists(key_path):
        return None

    xls = pd.ExcelFile(key_path)
    if not xls.sheet_names:
        return None

    df = pd.read_excel(key_path, sheet_name=xls.sheet_names[0])
    if df.empty:
        return None

    cols = {str(c).strip().lower(): c for c in df.columns}
    q_col = cols.get("questionno") or cols.get("question") or cols.get("qno")
    a_col = cols.get("correctoption") or cols.get("answer") or cols.get("correct")

    key_map: dict[int, str] = {}
    if q_col is not None and a_col is not None:
        for _, row in df.iterrows():
            try:
                q_num = int(row[q_col])
            except Exception:
                continue
            key_map[q_num] = _normalize_answer(row[a_col])
    else:
        first_row = df.iloc[0].to_dict()
        for col_name, val in first_row.items():
            match = re.search(r"(\d+)", str(col_name))
            if not match:
                continue
            key_map[int(match.group(1))] = _normalize_answer(val)

    return {q: a for q, a in key_map.items() if 1 <= q <= TOTAL_QUESTIONS} or None


def run_omr_backend(
    image_path: str,
    model_path: str = "best.pt",
    key_path: str | None = "key.xlsx",
    output_dir: str = ".",
    annotate: bool = True,
    score_correct: float = 1.0,
    score_wrong: float = 0.0,
    extract_barcode: bool = True,
    known_seats: set[str] | None = None,
    write_csv: bool = True,
) -> dict[str, Any]:
    """
    Backend integration entry-point.

    Returns dict with:
    - selected answers map
    - evaluation summary
    - barcode value (if extracted)
    - output file paths
    """
    output_base = Path(output_dir)
    output_base.mkdir(parents=True, exist_ok=True)

    img_name = Path(image_path).stem
    detail_csv = str(output_base / f"{img_name}_evaluation.csv")
    summary_csv = str(output_base / f"{img_name}_summary.csv")
    annotated_path = str(output_base / f"{img_name}_annotated.jpg")

    model = _load_model(model_path)
    img = _load_image(image_path)
    detections = model(img, conf=CONF_THRESHOLD, verbose=False)[0]
    barcode_value = None
    barcode_candidates: list[str] = []
    barcode_source: str | None = None
    if extract_barcode:
        barcode_value, barcode_candidates, barcode_source = _extract_barcode_detailed(
            img,
            known_seats=known_seats,
        )

    answers, ann_rows = _extract_answers(img, detections)
    if not answers:
        raise RuntimeError("No answers detected from image")

    key_map = _load_key_map(key_path)
    detail_rows: list[dict[str, Any]] = []
    attempted = 0
    correct = 0
    wrong = 0
    blank = 0
    total_score = 0.0

    for q_num in range(1, TOTAL_QUESTIONS + 1):
        selected = _normalize_answer(answers.get(q_num, "-"))
        correct_option = _normalize_answer((key_map or {}).get(q_num, "-"))

        if selected == "-":
            status = "BLANK"
            marks = 0.0
            blank += 1
        else:
            attempted += 1
            if key_map is not None and correct_option != "-" and selected == correct_option:
                status = "CORRECT"
                marks = float(score_correct)
                correct += 1
            else:
                status = "WRONG" if key_map is not None else "SELECTED"
                marks = float(score_wrong) if key_map is not None else 0.0
                if key_map is not None:
                    wrong += 1

        total_score += marks
        detail_rows.append(
            {
                "Image": Path(image_path).name,
                "Question": q_num,
                "SelectedOption": selected,
                "CorrectOption": correct_option,
                "Status": status,
                "Marks": marks,
            }
        )

    if write_csv:
        pd.DataFrame(detail_rows).to_csv(detail_csv, index=False)
    else:
        detail_csv = ""

    summary = {
        "Image": Path(image_path).name,
        "TotalQuestions": TOTAL_QUESTIONS,
        "Attempted": attempted,
        "Correct": correct,
        "Wrong": wrong,
        "Blank": blank,
        "TotalScore": total_score,
    }
    if write_csv:
        pd.DataFrame([summary]).to_csv(summary_csv, index=False)
    else:
        summary_csv = ""

    if annotate:
        _draw_annotated(img, ann_rows, annotated_path)
    else:
        annotated_path = ""

    return {
        "image": Path(image_path).name,
        "answers": answers,
        "summary": summary,
        "detail_csv": detail_csv,
        "summary_csv": summary_csv,
        "annotated_image": annotated_path,
        "key_used": bool(key_map),
        "barcode": barcode_value,
        "barcode_candidates": barcode_candidates,
        "barcode_source": barcode_source,
    }