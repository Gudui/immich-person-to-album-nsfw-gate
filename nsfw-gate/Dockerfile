FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    pip install --no-cache-dir fastapi uvicorn "nudenet>=3.4.2" python-multipart && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
COPY app.py /app.py
EXPOSE 9109
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9109"]
