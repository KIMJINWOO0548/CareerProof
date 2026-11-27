FROM node:22-bookworm-slim AS node-runtime
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/careerproof
COPY backend backend
COPY skills/careerproof-resume/SKILL.md skills/careerproof-resume/SKILL.md
COPY frontend frontend
COPY package.json .
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY docs/ui/style.css docs/ui/style.css
RUN mkdir /var/lib/careerproof && chown 65534:65534 /var/lib/careerproof
ENV CAREERPROOF_CONTAINER=1 CAREERPROOF_DATA_DIR=/var/lib/careerproof PYTHONDONTWRITEBYTECODE=1
USER 65534:65534
EXPOSE 8765
CMD ["python", "-m", "backend"]
