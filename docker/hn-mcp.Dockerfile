# erithwik/mcp-hn ships stdio only, but TrueForge connects to MCP servers over
# HTTP. supergateway bridges the two: it runs the stdio server as a child process
# and exposes it as a streamable-HTTP endpoint.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# uv provides uvx, which runs mcp-hn straight from PyPI without a venv to manage.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Install both up front so the container starts serving immediately
# instead of resolving packages on first request.
# mcp-hn (0.1.0) is written against the 1.x MCP Python SDK; the 2.x API drops
# Server.list_tools and the server dies on startup. Pin it back.
RUN uv tool install "mcp-hn" --with "mcp[cli]<1.3" && npm install -g supergateway

EXPOSE 8086
CMD ["supergateway", \
     "--stdio", "mcp-hn", \
     "--outputTransport", "streamableHttp", \
     "--port", "8086", \
     "--streamableHttpPath", "/mcp"]
