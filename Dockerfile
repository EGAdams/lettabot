FROM node:20-slim
LABEL archive.note="lettabot (EGAdams fork of letta-ai/lettabot) - node bot with python ffmpeg venv. Best-effort npm install; python .venv_ffmpeg archived as-is (not reinstalled)."
WORKDIR /project
COPY . /project
RUN npm install || echo "npm install failed/partial - source archived regardless"
CMD ["bash"]
