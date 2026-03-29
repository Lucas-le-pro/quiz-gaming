from flask import Flask, render_template, request, session, redirect, url_for, jsonify
from flask_sqlalchemy import SQLAlchemy
from datetime import datetime, timedelta
import anthropic
import random
import string
import os
import requests

app = Flask(__name__)
app.secret_key = "game-studio-lucas-2024"
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///gamestudio.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)

CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY", "")
AI_LIMIT_PER_HOUR = 45

# GitHub Actions pour l'envoi d'emails
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "")  # ex: "tonpseudo/game-studio-emails"
GITHUB_WORKFLOW = "send-email.yml"

def envoyer_email_github(email, code):
    if not GITHUB_TOKEN or not GITHUB_REPO:
        print(f"\n[EMAIL NON ENVOYE - GitHub non configuré]\nCode pour {email} : {code}\n")
        return
    url = f"https://api.github.com/repos/{GITHUB_REPO}/actions/workflows/{GITHUB_WORKFLOW}/dispatches"
    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json"
    }
    payload = {
        "ref": "main",
        "inputs": {
            "email": email,
            "code": code
        }
    }
    res = requests.post(url, json=payload, headers=headers)
    if res.status_code == 204:
        print(f"[EMAIL] Code envoyé à {email} via GitHub Actions")
    else:
        print(f"[EMAIL ERREUR] {res.status_code} - {res.text}")

# ─── Modèles ──────────────────────────────────────────────────────────────────

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    ai_messages_count = db.Column(db.Integer, default=0)
    ai_reset_time = db.Column(db.DateTime, default=datetime.utcnow)
    projects = db.relationship("Project", backref="owner", lazy=True)

class Project(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    code = db.Column(db.Text, default="// Commence à coder ton jeu ici !\n")
    language = db.Column(db.String(20), default="javascript")
    is_public = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)

# ─── Auth ─────────────────────────────────────────────────────────────────────

def gen_code():
    return ''.join(random.choices(string.digits, k=6))

@app.route("/")
def index():
    if session.get("user_id"):
        return redirect(url_for("dashboard"))
    return render_template("index.html")

@app.route("/auth/start", methods=["POST"])
def auth_start():
    data = request.json
    email = data.get("email", "").strip().lower()
    username = data.get("username", "").strip()

    if not email or not username:
        return jsonify({"error": "Email et nom d'utilisateur requis"}), 400

    # Vérifier si le username est pris par quelqu'un d'autre
    existing_user = User.query.filter_by(email=email).first()
    other_user = User.query.filter_by(username=username).first()
    if other_user and (not existing_user or other_user.id != existing_user.id):
        return jsonify({"error": "Nom d'utilisateur déjà pris"}), 400

    code = gen_code()
    session["pending_email"] = email
    session["pending_username"] = username
    session["pending_code"] = code
    session["code_expires"] = (datetime.utcnow() + timedelta(minutes=10)).isoformat()

    envoyer_email_github(email, code)

    return jsonify({"ok": True, "email": email})

@app.route("/verify")
def verify_page():
    if not session.get("pending_email"):
        return redirect(url_for("index"))
    return render_template("verify.html", email=session["pending_email"])

@app.route("/auth/verify", methods=["POST"])
def auth_verify():
    data = request.json
    code_saisi = data.get("code", "").strip()

    if not session.get("pending_code"):
        return jsonify({"error": "Session expirée"}), 400

    expires = datetime.fromisoformat(session["code_expires"])
    if datetime.utcnow() > expires:
        return jsonify({"error": "Code expiré, recommence"}), 400

    if code_saisi != session["pending_code"]:
        return jsonify({"error": "Code incorrect"}), 400

    email = session.pop("pending_email")
    username = session.pop("pending_username")
    session.pop("pending_code")
    session.pop("code_expires")

    user = User.query.filter_by(email=email).first()
    if not user:
        user = User(username=username, email=email)
        db.session.add(user)
        db.session.commit()
    else:
        # Mettre à jour le username si changé
        user.username = username
        db.session.commit()

    session["user_id"] = user.id
    session["username"] = user.username
    return jsonify({"ok": True})

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))

# ─── Dashboard ────────────────────────────────────────────────────────────────

@app.route("/dashboard")
def dashboard():
    if not session.get("user_id"):
        return redirect(url_for("index"))
    user = User.query.get(session["user_id"])
    projects = Project.query.filter_by(user_id=user.id).order_by(Project.updated_at.desc()).all()
    return render_template("dashboard.html", user=user, projects=projects)

@app.route("/project/new", methods=["POST"])
def new_project():
    if not session.get("user_id"):
        return jsonify({"error": "Non connecté"}), 401
    data = request.json
    project = Project(name=data["name"], user_id=session["user_id"])
    db.session.add(project)
    db.session.commit()
    return jsonify({"id": project.id})

@app.route("/project/<int:pid>")
def editor(pid):
    if not session.get("user_id"):
        return redirect(url_for("index"))
    project = Project.query.get_or_404(pid)
    if project.user_id != session["user_id"] and not project.is_public:
        return redirect(url_for("dashboard"))
    user = User.query.get(session["user_id"])
    return render_template("editor.html", project=project, user=user)

@app.route("/project/<int:pid>/save", methods=["POST"])
def save_project(pid):
    if not session.get("user_id"):
        return jsonify({"error": "Non connecté"}), 401
    project = Project.query.get_or_404(pid)
    if project.user_id != session["user_id"]:
        return jsonify({"error": "Accès refusé"}), 403
    data = request.json
    project.code = data.get("code", project.code)
    project.name = data.get("name", project.name)
    project.is_public = data.get("is_public", project.is_public)
    project.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"ok": True})

@app.route("/project/<int:pid>/delete", methods=["POST"])
def delete_project(pid):
    if not session.get("user_id"):
        return jsonify({"error": "Non connecté"}), 401
    project = Project.query.get_or_404(pid)
    if project.user_id != session["user_id"]:
        return jsonify({"error": "Accès refusé"}), 403
    db.session.delete(project)
    db.session.commit()
    return jsonify({"ok": True})

# ─── IA ───────────────────────────────────────────────────────────────────────

@app.route("/ai/chat", methods=["POST"])
def ai_chat():
    if not session.get("user_id"):
        return jsonify({"error": "Non connecté"}), 401

    user = User.query.get(session["user_id"])
    now = datetime.utcnow()

    if now >= user.ai_reset_time + timedelta(hours=1):
        user.ai_messages_count = 0
        user.ai_reset_time = now

    if user.ai_messages_count >= AI_LIMIT_PER_HOUR:
        reset_in = int((user.ai_reset_time + timedelta(hours=1) - now).total_seconds() / 60)
        return jsonify({"error": f"Limite atteinte. Reset dans {reset_in} min."}), 429

    if not CLAUDE_API_KEY:
        return jsonify({"error": "Clé API Claude manquante"}), 500

    data = request.json
    message = data.get("message", "")
    code_context = data.get("code", "")

    client = anthropic.Anthropic(api_key=CLAUDE_API_KEY)
    prompt = f"Tu es un assistant de création de jeux. Tu aides à écrire du code JavaScript pour des jeux.\n\nCode actuel:\n```\n{code_context}\n```\n\nQuestion: {message}"

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}]
    )

    user.ai_messages_count += 1
    db.session.commit()

    return jsonify({
        "response": response.content[0].text,
        "remaining": AI_LIMIT_PER_HOUR - user.ai_messages_count
    })

# ─── Explore ──────────────────────────────────────────────────────────────────

@app.route("/explore")
def explore():
    if not session.get("user_id"):
        return redirect(url_for("index"))
    projects = Project.query.filter_by(is_public=True).order_by(Project.updated_at.desc()).all()
    return render_template("explore.html", projects=projects)

if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(debug=True, port=5000)
