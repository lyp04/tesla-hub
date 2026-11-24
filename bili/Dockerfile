FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY static ./static
RUN groupadd -g 10002 bili && useradd -u 10002 -g 10002 -r -s /usr/sbin/nologin bili \
 && mkdir -p /data && chown bili:bili /data
USER bili
EXPOSE 8080
CMD ["python", "app.py"]
