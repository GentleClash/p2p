FROM python:3.13-slim-bookworm

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY webrtc.py .
COPY static/ ./static/
COPY templates/ ./templates/
COPY LICENSE README.md ./

RUN useradd -m appuser
RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 5000

CMD ["python", "-c", "from eventlet import wsgi; import eventlet; import webrtc; eventlet.wsgi.server(eventlet.listen(('0.0.0.0', 5000)), webrtc.app)"]
