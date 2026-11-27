FROM python:3.12-slim
WORKDIR /opt/careerproof
COPY backend backend
COPY frontend frontend
COPY docs/ui/style.css docs/ui/style.css
ENV CAREERPROOF_CONTAINER=1 PYTHONDONTWRITEBYTECODE=1
USER 65534:65534
EXPOSE 8765
CMD ["python", "-m", "backend"]
