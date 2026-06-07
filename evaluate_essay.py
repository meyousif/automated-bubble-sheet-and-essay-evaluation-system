import argparse
import os
import json
from config import GEMINI_API_KEY
from gemini_utils import call_gemini_api, extract_response_text, text_contents


def load_rubric(rubric_path="rubrics/rubric.json"):
    with open(rubric_path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_essay_text(text_path="outputs/essay_text.txt"):
    with open(text_path, "r", encoding="utf-8") as f:
        return f.read()


def evaluate_essay(essay_text, rubric):
    prompt = f"""
You are an impartial essay examiner.

Evaluate the student's essay strictly according to the given rubric.

RUBRIC:
{json.dumps(rubric, indent=2, ensure_ascii=False)}

STUDENT ESSAY:
{essay_text}

Rules:
- Use only the given rubric.
- Score each criterion separately.
- Give short reasoning for each criterion.
- Give total awarded marks.
- Return strict JSON only.

Return JSON in this exact structure:
{{
  "criterion_scores": [
    {{
      "name": "Grammar and Language",
      "awarded_marks": 0,
      "max_marks": 2,
      "reason": "..."
    }}
  ],
  "total_awarded": 0,
  "total_marks": {rubric.get("total_marks", 10)},
  "strengths": ["...", "..."],
  "weaknesses": ["...", "..."],
  "final_feedback": "..."
}}
"""

    response = call_gemini_api(
        api_key=GEMINI_API_KEY,
        model=evaluate_essay.model,
        contents=text_contents(prompt),
        retries=3,
    )

    text = extract_response_text(response)

    return json.loads(text)


def save_evaluation(result, filename="evaluation.json"):
    os.makedirs("outputs", exist_ok=True)
    path = os.path.join("outputs", filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=4, ensure_ascii=False)
    return path


def display_evaluation(result):
    print("\n=== EVALUATION RESULT ===\n")
    for item in result["criterion_scores"]:
        print(f"{item['name']}")
        print(f"  Awarded: {item['awarded_marks']} / {item['max_marks']}")
        print(f"  Reason : {item['reason']}\n")

    print(f"Total: {result['total_awarded']} / {result['total_marks']}")

    print("\nStrengths:")
    for s in result.get("strengths", []):
        print(f"- {s}")

    print("\nWeaknesses:")
    for w in result.get("weaknesses", []):
        print(f"- {w}")

    print("\nFinal Feedback:")
    print(result.get("final_feedback", ""))


def build_arg_parser():
    parser = argparse.ArgumentParser(description="Evaluate an essay against a generated rubric.")
    parser.add_argument("--rubric", default="rubrics/rubric.json", help="Path to the rubric JSON file.")
    parser.add_argument("--essay", default="outputs/essay_text.txt", help="Path to the extracted essay text file.")
    parser.add_argument("--output", default="evaluation.json", help="Output JSON filename inside outputs/.")
    parser.add_argument("--model", default="gemini-2.5-flash", help="Gemini model to use.")
    return parser


def main():
    args = build_arg_parser().parse_args()
    evaluate_essay.model = args.model
    rubric = load_rubric(args.rubric)
    essay_text = load_essay_text(args.essay)
    result = evaluate_essay(essay_text, rubric)
    saved = save_evaluation(result, args.output)
    display_evaluation(result)
    print(f"\nEvaluation saved at: {saved}")


if __name__ == "__main__":
    main()