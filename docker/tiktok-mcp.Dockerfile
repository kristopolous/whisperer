# seym0n/tiktok-mcp is a Node/TypeScript stdio server (build/index.js after
# `npm run build`), bridged to HTTP with supergateway like the other stdio
# servers here. Needs a TikNeuron API key — it proxies TikTok search/scraping
# rather than hitting TikTok directly.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/seym0n/tiktok-mcp.git /app
WORKDIR /app
RUN npm install && npm run build && npm install -g supergateway

ENV TIKNEURON_MCP_API_KEY=""
EXPOSE 8093
CMD ["sh", "-c", \
     "supergateway --stdio 'node build/index.js' \
        --outputTransport streamableHttp --port 8093 --streamableHttpPath /mcp"]
