import os

def verify_login(username, password):
    username = username.strip()
    password = password.strip()

    # Temporary demo users
    # Later DB + hashed passwords use karenge
    valid_users = {
        "admin": {
            "password": "1234",
            "role": "Admin",
            "redirect": "dashboard.html",
            "name": "System Administrator"
        },
        "examiner": {
            "password": "exam123",
            "role": "Examiner",
            "redirect": "dashboard.html",
            "name": "Examiner User"
        }
    }

    if not username or not password:
        return {
            "success": False,
            "message": "Username and password are required."
        }

    user = valid_users.get(username)

    if not user or user["password"] != password:
        return {
            "success": False,
            "message": "Invalid username or password."
        }

    return {
        "success": True,
        "message": "Login successful.",
        "username": username,
        "name": user["name"],
        "role": user["role"],
        "redirect": user["redirect"]
    }


def close_app():
    os._exit(0)