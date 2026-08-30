# jlbadano/ig-mcp is stdio-only (MCP_TRANSPORT is not configurable past stdio),
# so it's bridged to HTTP with supergateway like the hn/signal/whatsapp servers
# in this directory. This manages the company's OWN Instagram Business account
# (via the Graph API) — posts, DMs, insights — not a general Instagram search.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates nodejs npm \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/jlbadano/ig-mcp.git /app
WORKDIR /app
RUN pip install --no-cache-dir -r requirements.txt && npm install -g supergateway

EXPOSE 8092
CMD ["sh", "-c", \
     "supergateway --stdio 'python -m src.instagram_mcp_server' \
        --outputTransport streamableHttp --port 8092 --streamableHttpPath /mcp"]
