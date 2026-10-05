# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-05

### Added

- HTTP, HTTPS, TCP, ping and keyword monitors with interval, timeout, expected status range, redirect policy and failure thresholds
- Certificate validation and expiry warnings for HTTPS targets
- Incident tracking, uptime for 24 hours, 7 days and 30 days, response time average and p95, check history and retention cleanup
- Discord, signed webhook and SMTP (TLS and STARTTLS) notifications with retry and cooldown
- SSRF protection with DNS pinning, redirect re-validation and an opt-in for private targets
- REST API with Bearer authentication, input validation and masked notification targets
- Worker with jitter, overlap prevention and graceful shutdown
- Memory, JSON file and PostgreSQL storage adapters with SQL migrations
- `server-monitor api`, `worker` and `check` commands
- Dockerfile, Docker Compose file and GitHub Actions workflow
