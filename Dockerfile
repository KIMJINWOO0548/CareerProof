FROM python:3.12-slim
WORKDIR /opt/careerproof
COPY backend backend
COPY frontend frontend
COPY docs/ui/style.css docs/ui/style.css
RUN mkdir /var/lib/careerproof && chown 65534:65534 /var/lib/careerproof
ENV CAREERPROOF_CONTAINER=1 CAREERPROOF_DATA_DIR=/var/lib/careerproof PYTHONDONTWRITEBYTECODE=1
USER 65534:65534
EXPOSE 8765
CMD ["python", "-m", "backend"]
