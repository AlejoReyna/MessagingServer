FROM postgres:18-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends restic openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
COPY infra/backup.sh /usr/local/bin/private-chat-backup
ENTRYPOINT ["bash", "/usr/local/bin/private-chat-backup"]
CMD ["backup"]
