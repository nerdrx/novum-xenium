FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash git nodejs npm ripgrep && rm -rf /var/lib/apt/lists/*
COPY server.py /opt/executor/server.py
USER 1000:1000
WORKDIR /workspace
CMD ["python", "/opt/executor/server.py"]
