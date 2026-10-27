FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Сначала зависимости: слой pip переиспользуется, пока не менялся pyproject.toml.
# Пакет ставится editable, чтобы правки в ./app подхватывались без пересборки.
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e ".[dev]"

COPY . .

EXPOSE 8000

# Запуск без .sh-файлов: на Windows такой файл получает CRLF, и контейнер падает
# с `/bin/sh^M: bad interpreter`. Миграции применяет сам api перед стартом.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
