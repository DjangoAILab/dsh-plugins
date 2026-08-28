# Public media assets

This directory contains privacy-reviewed media used by the public project homepage. Read this file when adding,
replacing, or auditing screenshots, recordings, GIFs, or other public-facing assets.

## Current demo provenance

- `browser-use.gif` was rendered from three real states produced by `dsh-browser-control`'s CDP client and action
  primitives against an isolated in-memory page and a temporary Chrome profile.
- `computer-use.gif` was rendered from window-only captures before and after `dsh-computer-use`'s Swift AX driver
  resolved and edited a temporary TextEdit document.

The media intentionally contains no account, browser history, production URL, notification, machine name, absolute
path, or desktop-wide capture. The browser page and TextEdit document use synthetic English copy.

## Rules for future assets

1. Prefer a purpose-built local demo over redacting a production screenshot.
2. Capture only the target window or isolated browser viewport; never publish a full desktop by default.
3. Remove image metadata and inspect every frame of animated media, not only the thumbnail.
4. Scan visible text for identities, hostnames, paths, service names, tokens, URLs, and realistic test output.
5. Record what executed the demo and whether the result is live, staged, or illustrative. Never present a mock as a
   real run.
