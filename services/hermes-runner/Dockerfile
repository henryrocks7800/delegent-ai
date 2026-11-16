FROM python:3.11-slim
ENV HERMES_HOME=/data/hermes PYTHONUNBUFFERED=1
# Document-toolchain system deps (tesseract OCR engine + English data,
# poppler for pdf2image, dejavu fonts for headless matplotlib) alongside the
# base tooling. Keeps the parked railway_legacy path at capability parity with
# the live Fly golden image (Dockerfile.fly).
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl git nodejs npm \
        tesseract-ocr tesseract-ocr-eng poppler-utils fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Agent document toolchain (PDF/OCR/CSV/Excel/Office) — build-time wheels only.
COPY requirements-documents.txt .
RUN pip install --no-cache-dir -r requirements-documents.txt
COPY server.py .
# Railway provides persistent storage through configured Volumes; Dockerfile VOLUME is rejected by Railway builders.
EXPOSE 8642
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8642"]
