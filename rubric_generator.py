import argparse
import os
import json
from config import GEMINI_API_KEY
from gemini_utils import call_gemini_api, extract_response_text, text_contents


def generate_rubric(subject, grade_level, topic, total_marks=10):
    prompt = f"""
You are an academic rubric designer.

Generate a clear essay evaluation rubric in strict JSON format only.
English
Requirements:
- Subject: {subject}
- Grade Level: {grade_level}
- Essay Topic: {topic}
- Total Marks: {total_marks}
- The rubric should be fair, clear, and reusable.
- Include these criteria:
  1. Grammar and Language
  2. Coherence and Organization
  3. Content Relevance
  4. Critical Thinking / Depth
  5. Presentation / Clarity

Return JSON only in this format:
{{
  "subject": "{subject}",
  "grade_level": "{grade_level}",
  "topic": "{topic}",
  "total_marks": {total_marks},
  "criteria": [
    {{
      "name": "Grammar and Language",
      "marks": 2,
      "description": "..."
    }},
    {{
      "name": "Coherence and Organization",
      "marks": 2,
      "description": "..."
    }},
    {{
      "name": "Content Relevance",
      "marks": 2,
      "description": "..."
    }},
    {{
      "name": "Critical Thinking / Depth",
      "marks": 2,
      "description": "..."
    }},
    {{
      "name": "Presentation / Clarity",
      "marks": 2,
      "description": "..."
    }}
  ],
  "instructions_for_students": [
    "...",
    "..."
  ]
}}
"""

    response = call_gemini_api(
      api_key=GEMINI_API_KEY,
      model=generate_rubric.model,
      contents=text_contents(prompt),
      retries=3,
    )

    text = extract_response_text(response)

    return json.loads(text)


def save_rubric(rubric, filename="rubric.json"):
    os.makedirs("rubrics", exist_ok=True)
    path = os.path.join("rubrics", filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rubric, f, indent=4, ensure_ascii=False)
    return path


def display_rubric(rubric):
    print("\n=== GENERATED RUBRIC ===")
    print(f"Subject: {rubric['subject']}")
    print(f"Grade Level: {rubric['grade_level']}")
    print(f"Topic: {rubric['topic']}")
    print(f"Total Marks: {rubric['total_marks']}\n")

    for i, c in enumerate(rubric["criteria"], start=1):
        print(f"{i}. {c['name']} ({c['marks']} marks)")
        print(f"   {c['description']}")

    print("\nInstructions for Students:")
    for item in rubric.get("instructions_for_students", []):
        print(f"- {item}")

def build_arg_parser():
    parser = argparse.ArgumentParser(description="Generate an essay rubric using Gemini.")
    parser.add_argument("--subject", help="Subject name.")
    parser.add_argument("--grade-level", dest="grade_level", help="Grade or class level.")
    parser.add_argument("--topic", help="Essay topic.")
    parser.add_argument("--total-marks", dest="total_marks", type=int, default=10, help="Total marks for the rubric.")
    parser.add_argument("--output", default="rubric.json", help="Output JSON filename inside rubrics/.")
    parser.add_argument("--model", default="gemini-2.5-flash", help="Gemini model to use.")
    return parser


def main():
    args = build_arg_parser().parse_args()
    generate_rubric.model = args.model
    subject = args.subject or input("Enter subject: ").strip()
    grade_level = args.grade_level or input("Enter grade level: ").strip()
    topic = args.topic or input("Enter essay topic: ").strip()

    if not subject or not grade_level or not topic:
        raise ValueError("Subject, grade level, and topic are required.")

    rubric = generate_rubric(subject, grade_level, topic, args.total_marks)
    saved = save_rubric(rubric, args.output)
    display_rubric(rubric)
    print(f"\nRubric saved at: {saved}")


if __name__ == "__main__":
    main()