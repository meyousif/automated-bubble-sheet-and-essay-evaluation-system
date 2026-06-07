import cv2
from PIL import Image
import numpy as np
import json
import pytesseract
import os

# ==========================================
# 1. TESSERACT SETUP
# ==========================================
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

# ==========================================
# 2. AUTO ALIGNMENT FUNCTION
# ==========================================
def auto_align_sheet(scanned_img, master_img, verbose=False):
    if verbose:
        print("-> Aligning sheet...")

    im1Gray = cv2.cvtColor(scanned_img, cv2.COLOR_BGR2GRAY)
    im2Gray = cv2.cvtColor(master_img, cv2.COLOR_BGR2GRAY)

    orb = cv2.ORB_create(5000)
    keypoints1, descriptors1 = orb.detectAndCompute(im1Gray, None)
    keypoints2, descriptors2 = orb.detectAndCompute(im2Gray, None)

    matcher = cv2.DescriptorMatcher_create(cv2.DESCRIPTOR_MATCHER_BRUTEFORCE_HAMMING)
    matches = matcher.match(descriptors1, descriptors2, None)
    matches = sorted(matches, key=lambda x: x.distance)

    numGoodMatches = int(len(matches) * 0.15)
    matches = matches[:numGoodMatches]

    points1 = np.zeros((len(matches), 2), dtype=np.float32)
    points2 = np.zeros((len(matches), 2), dtype=np.float32)

    for i, match in enumerate(matches):
        points1[i, :] = keypoints1[match.queryIdx].pt
        points2[i, :] = keypoints2[match.trainIdx].pt

    h, mask = cv2.findHomography(points1, points2, cv2.RANSAC)
    height, width, channels = master_img.shape

    aligned_img = cv2.warpPerspective(scanned_img, h, (width, height))
    return aligned_img

# ==========================================
# 3. OCR FUNCTION
# ==========================================
def extract_student_info_from_image(aligned_img, verbose=False):
    if verbose:
        print("-> Extracting student info via OCR...")

    def preprocess_roi(roi, scale=2.0):
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        if scale and scale != 1.0:
            gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        gray = cv2.bilateralFilter(gray, 5, 75, 75)
        thresh = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                       cv2.THRESH_BINARY, 31, 10)
        return thresh

    def ocr_text(y1, y2, x1, x2, config):
        roi = aligned_img[y1:y2, x1:x2]
        prepped = preprocess_roi(roi)
        return pytesseract.image_to_string(prepped, config=config).strip()

    def ocr_digits(y1, y2, x1, x2):
        config = "--oem 1 --psm 7 -c tessedit_char_whitelist=0123456789"
        text = ocr_text(y1, y2, x1, x2, config)
        text = text.replace("O", "0").replace("o", "0")
        return "".join(filter(str.isdigit, text))

    def ocr_name(y1, y2, x1, x2):
        config = "--oem 1 --psm 7"
        return ocr_text(y1, y2, x1, x2, config)

    try:
        data = {
            "SeatNumber": ocr_digits(600, 1100, 150, 950),
            "Name": ocr_name(750, 850, 1290, 2500),
            "FatherName": ocr_name(900, 1000, 1480, 2500),
            "CNIC": ocr_digits(1020, 1150, 1400, 2500)
        }
        return data
    except:
        return {"SeatNumber": "N/A", "Name": "N/A", "FatherName": "N/A", "CNIC": "N/A"}


def extract_student_info(image_path, verbose=False):
    aligned_img = cv2.imread(image_path)
    if aligned_img is None:
        return {"SeatNumber": "N/A", "Name": "N/A", "FatherName": "N/A", "CNIC": "N/A"}
    return extract_student_info_from_image(aligned_img, verbose=verbose)

# ==========================================
# 4. BUBBLE GRADING FUNCTION
# ==========================================
def grade_bubbles(image, verbose=False):
    if verbose:
        print("-> Detecting bubbles...")

    TL = (302, 1748); TR = (3042, 1748)
    BL = (285, 4331); BR = (3042, 4314)

    OPT_GAP_X = 103; COL_GAP_X = 777
    MAX_LOGICAL_X = (3 * COL_GAP_X) + (4 * OPT_GAP_X)
    MAX_LOGICAL_Y = 24
    BUBBLE_RADIUS = 25
    options_map = {0: "A", 1: "B", 2: "C", 3: "D", 4: "E"}

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    answers_data = []

    for col in range(4):
        for row in range(25):

            question_number = (col * 25) + row + 1
            mean_values = []
            boxes = []

            for opt in range(5):
                logical_x = (col * COL_GAP_X) + (opt * OPT_GAP_X)
                logical_y = row

                x_prop = logical_x / MAX_LOGICAL_X
                y_prop = logical_y / MAX_LOGICAL_Y

                x_top = TL[0] + x_prop * (TR[0] - TL[0])
                x_bottom = BL[0] + x_prop * (BR[0] - BL[0])
                current_x = int(x_top + y_prop * (x_bottom - x_top))

                y_left = TL[1] + y_prop * (BL[1] - TL[1])
                y_right = TR[1] + y_prop * (BR[1] - TR[1])
                current_y = int(y_left + x_prop * (y_right - y_left))

                y1 = max(0, current_y - BUBBLE_RADIUS)
                y2 = min(gray.shape[0], current_y + BUBBLE_RADIUS)
                x1 = max(0, current_x - BUBBLE_RADIUS)
                x2 = min(gray.shape[1], current_x + BUBBLE_RADIUS)

                roi = gray[y1:y2, x1:x2]
                mean_values.append(np.mean(roi))
                boxes.append((x1, y1, x2, y2))

            min_mean = min(mean_values)

            if min_mean > 180:
                answers_data.append({"Question": question_number, "SelectedOption": "BLANK"})
                continue

            marked = [i for i, val in enumerate(mean_values) if val < 170 and val < min_mean * 1.10]

            if len(marked) == 1:
                idx = marked[0]
                answers_data.append({"Question": question_number, "SelectedOption": options_map[idx]})
                x1, y1, x2, y2 = boxes[idx]
                cv2.rectangle(image, (x1, y1), (x2, y2), (0,255,0), 3)

            elif len(marked) > 1:
                letters = [options_map[i] for i in marked]
                answers_data.append({"Question": question_number,
                                     "SelectedOption": "DOUBLE (" + ",".join(letters) + ")"})
            else:
                answers_data.append({"Question": question_number, "SelectedOption": "BLANK"})

    return answers_data, image

# ==========================================
# 5. BATCH PROCESSING MAIN
# ==========================================
def run_batch(master_path, input_folder, output_folder, save_steps=False, verbose=False):
    if verbose:
        print("\n--- INTELLI-LEARN OMR BATCH ENGINE STARTED ---")

    os.makedirs(output_folder, exist_ok=True)

    def load_image_bgr(path):
        img = cv2.imread(path)
        if img is not None:
            return img
        try:
            with Image.open(path) as pil_img:
                pil_img = pil_img.convert("RGB")
                return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        except Exception:
            return None

    imMaster = load_image_bgr(master_path)
    if imMaster is None:
        raise FileNotFoundError("Master image not found.")

    all_students_results = []

    image_files = [
        name
        for name in os.listdir(input_folder)
        if name.lower().endswith((".jpg", ".jpeg", ".png", ".tif", ".tiff"))
    ]

    if not image_files:
        for root, _, files in os.walk(input_folder):
            for name in files:
                if name.lower().endswith((".jpg", ".jpeg", ".png", ".tif", ".tiff")):
                    image_files.append(os.path.join(root, name))

    image_files.sort()

    for filename in image_files:

        if verbose:
            print(f"\nProcessing: {filename}")

        scanned_path = filename
        if not os.path.isabs(scanned_path):
            scanned_path = os.path.join(input_folder, filename)
        imScanned = load_image_bgr(scanned_path)

        if imScanned is None:
            if verbose:
                print(f"Skipping unreadable image: {scanned_path}")
            continue

        try:
            aligned_img = auto_align_sheet(imScanned, imMaster, verbose=verbose)

            aligned_temp_path = os.path.join(output_folder, f"{filename}_aligned.jpg")
            if save_steps:
                cv2.imwrite(aligned_temp_path, aligned_img)

            student_details = extract_student_info_from_image(aligned_img, verbose=verbose)

            omr_results, final_img = grade_bubbles(aligned_img, verbose=verbose)

            student_details["TotalAttempted"] = len(omr_results)
            student_details["Answers"] = omr_results

            if save_steps:
                final_image_path = os.path.join(output_folder, f"{filename}_graded.jpg")
                cv2.imwrite(final_image_path, final_img)

            json_path = os.path.join(output_folder, f"{filename}_result.json")
            with open(json_path, "w") as f:
                json.dump(student_details, f, indent=4)

            all_students_results.append(student_details)

        except Exception:
            if verbose:
                print(f"Error processing {filename}")

    combined_json_path = os.path.join(output_folder, "ALL_STUDENTS_RESULTS.json")
    with open(combined_json_path, "w") as f:
        json.dump(all_students_results, f, indent=4)

    if verbose:
        print("\nBATCH PROCESSING COMPLETED SUCCESSFULLY!")

    return combined_json_path, all_students_results


if __name__ == "__main__":
    master_path = os.getenv("BUBBLE_MASTER_PATH", r"F:\BS Folder\BS-VI\AI Lab\python\updated\bubble_sheet_reader\sample_images\20230202145241664.tif")
    input_folder = os.getenv("BUBBLE_INPUT_FOLDER", r"F:\BS Folder\BS-VI\AI Lab\python\updated\bubble_sheet_reader\sample_images")
    output_folder = os.getenv("BUBBLE_OUTPUT_FOLDER", r"F:\BS Folder\BS-VI\AI Lab\python\updated\bubble_sheet_reader\output")
    run_batch(master_path, input_folder, output_folder, save_steps=False, verbose=True)