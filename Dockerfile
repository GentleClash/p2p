FROM python:3.13-slim-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    python3-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

HEALTHCHECK --interval=840s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f https://p2p-80my.onrender.com/status || exit 1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY static/ ./static/
COPY templates/ ./templates/
COPY LICENSE README.md ./

RUN useradd -m appuser && \
    chown -R appuser:appuser /app
USER appuser

EXPOSE 5000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5000", "--workers", "1"]