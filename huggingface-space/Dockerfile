# Free Ollama hosting on a Hugging Face Space (Docker SDK, CPU basic tier).
#
# The model is pulled at BUILD time (baked into the image) rather than at
# container startup, so the Space has it ready immediately on cold start /
# wake-from-sleep instead of re-downloading multiple GB on every wake.

FROM ollama/ollama:latest

# Hugging Face Spaces run containers as a non-root user with UID 1000.
# Give that user a writable home so Ollama can store its model cache there.
ENV HOME=/home/user
ENV OLLAMA_MODELS=/home/user/.ollama/models
RUN useradd -m -u 1000 user \
    && mkdir -p /home/user/.ollama/models \
    && chown -R user:user /home/user

USER user

# Bake the model into the image so it ships with the build instead of
# being downloaded per-request. Change the model name here (and in the
# OLLAMA_MODEL script property) to use a different one.
RUN ollama serve & \
    sleep 5 && \
    ollama pull llama3 && \
    pkill ollama || true

# Ollama's default port — set as this Space's app_port in README.md.
EXPOSE 11434
ENV OLLAMA_HOST=0.0.0.0:11434

CMD ["serve"]
