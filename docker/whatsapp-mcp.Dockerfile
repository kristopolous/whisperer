# lharries/whatsapp-mcp is two processes: a Go bridge that holds the WhatsApp
# Web session and writes messages to SQLite, and a Python MCP server that reads
# it. Both run here; supergateway puts the stdio server on HTTP.
#
# The bridge prints a QR code on first run that has to be scanned from a phone.
# Do that once interactively before starting the service detached:
#   docker compose run --rm -it whatsapp-mcp /app/link.sh
FROM golang:1.23-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 nodejs npm ffmpeg \
 && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

RUN git clone --depth 1 https://github.com/lharries/whatsapp-mcp.git /app
WORKDIR /app/whatsapp-bridge
RUN go build -o /usr/local/bin/whatsapp-bridge .

WORKDIR /app/whatsapp-mcp-server
RUN uv sync && npm install -g supergateway

# Session and message history live here; mount it so a re-link isn't needed on
# every container rebuild.
VOLUME ["/app/whatsapp-bridge/store"]

RUN printf '#!/bin/sh\nexec whatsapp-bridge\n' > /app/link.sh && chmod +x /app/link.sh

EXPOSE 8090
CMD ["sh", "-c", \
     "whatsapp-bridge & \
      exec supergateway --stdio 'uv run main.py' \
        --outputTransport streamableHttp --port 8090 --streamableHttpPath /mcp"]
