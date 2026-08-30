# amitpuri/search-youtube ships a single-file FastMCP server that already
# speaks streamable HTTP natively (mode defaults to http) — no stdio bridge
# needed, unlike the hn/signal/whatsapp servers in this directory.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/amitpuri/search-youtube.git /src
WORKDIR /src/search-youtube-mcp-server
RUN pip install --no-cache-dir -r requirements.txt

# MCP_HOST/MCP_PORT are read by the script itself; left at the container's
# loopback since this runs on network_mode: host like every other server here.
ENV MCP_HOST=127.0.0.1
ENV MCP_PORT=8091
ENV YOUTUBE_API_KEY=""

CMD ["python", "youtube_mcp_server.py"]
