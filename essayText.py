import argparse
import os
from config import GEMINI_API_KEY
from gemini_utils import call_gemini_api, extract_response_text, image_contents


def extract_handwritten_text(image_path):
    prompt = """
You are an OCR system.

Extract the handwritten text exactly as written.
Do not correct grammar, spelling, or punctuation.
Do not omit any words, symbols, or lines.
Preserve line breaks and paragraph breaks exactly.
Return plain text only, no extra commentary.
If a word is unclear, keep the closest visual guess and append [illegible].
"""

    response = call_gemini_api(
        api_key=GEMINI_API_KEY,
        model=extract_handwritten_text.model,
        contents=image_contents(prompt, image_path),
        retries=3,
    )

    return extract_response_text(response)


def save_extracted_text(text, filename="essay_text.txt"):
    os.makedirs("outputs", exist_ok=True)
    path = os.path.join("outputs", filename)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def build_arg_parser():
    parser = argparse.ArgumentParser(description="Extract handwritten essay text from an image.")
    parser.add_argument("--image", dest="image_path", help="Path to the essay image file.")
    parser.add_argument("--output", default="essay_text.txt", help="Output text filename inside outputs/.")
    parser.add_argument("--model", default="gemini-2.5-flash", help="Gemini model to use.")
    return parser


def main():
    args = build_arg_parser().parse_args()
    extract_handwritten_text.model = args.model
    image_path = args.image_path or input("Enter essay image path: ").strip()
    if not image_path:
        raise ValueError("Image path is required.")

    text = extract_handwritten_text(image_path)
    saved = save_extracted_text(text, args.output)

    print("\n=== EXTRACTED TEXT ===\n")
    print(text)
    print(f"\nText saved at: {saved}")


if __name__ == "__main__":
    main()