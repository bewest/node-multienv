FROM mongo:6

LABEL org.opencontainers.image.title="Nightscout Utility Container"
LABEL org.opencontainers.image.description="Utility scripts for Nightscout multi-tenant Kubernetes platform"
LABEL org.opencontainers.image.authors="nightscout-platform"

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    jq \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sL https://github.com/apache/kafka/releases/download/3.6.0/kafka_2.13-3.6.0.tgz | \
    tar xz -C /opt && \
    mv /opt/kafka_2.13-3.6.0 /opt/kafka && \
    rm -rf /opt/kafka/site-docs

ENV PATH="/opt/kafka/bin:${PATH}"

COPY scripts /opt/ns-utility/scripts

RUN chmod +x /opt/ns-utility/scripts/lib/*.sh && \
    chmod +x /opt/ns-utility/scripts/entrypoints/*.sh

ENV PATH="/opt/ns-utility/scripts/entrypoints:${PATH}"

WORKDIR /opt/ns-utility

CMD ["/opt/ns-utility/scripts/entrypoints/debug-shell.sh"]
