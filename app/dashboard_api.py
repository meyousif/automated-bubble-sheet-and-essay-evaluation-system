def get_dashboard_data():
    """
    Temporary dashboard data.
    Later this will be connected with:
    - bubble sheet backend
    - essay backend
    - reports backend
    """

    return {
        "stats": {
            "bubble_sheets_uploaded": 156,
            "essays_uploaded": 89,
            "evaluations_completed": 234,
            "reports_generated": 45
        },
        "recent_activity": [
            {
                "type": "upload",
                "title": "Uploaded 15 bubble sheets for Midterm Exam",
                "time": "2 minutes ago"
            },
            {
                "type": "success",
                "title": "Completed evaluation for Student ID: 22F-1234",
                "time": "15 minutes ago"
            },
            {
                "type": "warning",
                "title": "Re-scan required for 3 bubble sheets (low quality)",
                "time": "1 hour ago"
            },
            {
                "type": "report",
                "title": "Generated report for Final Exam - Section A",
                "time": "2 hours ago"
            },
            {
                "type": "success",
                "title": "Essay evaluation completed - Grammar: 85, Coherence: 78",
                "time": "3 hours ago"
            },
            {
                "type": "upload",
                "title": "Uploaded 8 essays for Quiz 2",
                "time": "4 hours ago"
            }
        ]
    }