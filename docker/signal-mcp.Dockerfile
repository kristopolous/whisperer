# rymurr/signal-mcp drives signal-cli, so the image carries both: a JRE for
# signal-cli and Python for the MCP server. It speaks stdio, so supergateway
# fronts it with HTTP the same way the Hacker News bridge does.
FROM eclipse-temurin:21-jre

ARG SIGNAL_CLI_VERSION=0.13.12

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-venv nodejs npm \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
      | tar -xz -C /opt \
 && ln -s "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

RUN git clone --depth 1 https://github.com/rymurr/signal-mcp.git /app
WORKDIR /app
RUN uv sync && npm install -g supergateway

# SIGNAL_USER_ID is the registered phone number in +E.164 form.
ENV SIGNAL_USER_ID=""
EXPOSE 8089
CMD ["sh", "-c", \
     "supergateway --stdio \"uv run main.py --user-id $SIGNAL_USER_ID --transport stdio\" \
        --outputTransport streamableHttp --port 8089 --streamableHttpPath /mcp"]
