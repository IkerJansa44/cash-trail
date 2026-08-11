FROM node:22-slim AS codex
RUN npm install -g @openai/codex

FROM python:3.13-slim
COPY --from=codex /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=codex /usr/local/bin/node /usr/local/bin/node
RUN ln -s ../lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
