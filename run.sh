#!/usr/bin/env sh
set -e
docker compose up --build -d
echo "Traffic AI Lab: http://localhost:8000"
