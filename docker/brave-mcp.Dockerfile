# brave/brave-search-mcp-server speaks HTTP natively (no supergateway bridge
# needed, unlike hn/signal/whatsapp/instagram/tiktok in this directory).
FROM node:22-slim

RUN npm install -g @brave/brave-search-mcp-server

ENV BRAVE_API_KEY=""
ENV BRAVE_MCP_TRANSPORT=http
ENV BRAVE_MCP_PORT=8094
ENV BRAVE_MCP_HOST=127.0.0.1

EXPOSE 8094
CMD ["brave-search-mcp-server"]
