# Acknowledgements

Open source is a chain of work, not a blank page. This file distinguishes code provenance from community integration
and design research so that credit stays accurate.

## Vendored or adapted code

These relationships involve source code carried or adapted in this repository. Module-local license files remain the
authoritative notices.

- [`dsh-notifier`](plugins/manual/dsh-notifier/) is a vendored derivative of
  [`THEWOLFWALKER/dsh-notifier@0.7.3`](https://github.com/THEWOLFWALKER/dsh-notifier), licensed under MIT, with
  repository-specific additions and fixes. Some channel adapter behavior is adapted from
  [`CaoMeiYouRen/push-all-in-one`](https://github.com/CaoMeiYouRen/push-all-in-one) (MIT) and
  [`HCLonely/all-pusher-api`](https://github.com/HCLonely/all-pusher-api) (Apache-2.0). See its
  [third-party notices](plugins/manual/dsh-notifier/THIRD_PARTY_NOTICES.md).
- [`dsh-file-upload`](plugins/manual/dsh-file-upload/) is based on
  [`a903067276-rgb/dsh-file-upload`](https://github.com/a903067276-rgb/dsh-file-upload), licensed under MIT, and
  retains the upstream copyright in its [module license](plugins/manual/dsh-file-upload/LICENSE).
- [`dsh-web-mobile`](plugins/manual/dsh-web-mobile/) vendors and locally maintains
  [`mexiaosqwq/dsh-web-mobile@v1.0.0`](https://github.com/mexiaosqwq/dsh-web-mobile), licensed under MIT. Its
  [module license](plugins/manual/dsh-web-mobile/LICENSE) and upstream README are preserved.
- [`ops-ssh-manager`](plugins/manual/ops-ssh-manager/) adapts the destructive-command policy expressions and audit
  redaction behavior from [`bvisible/mcp-ssh-manager`](https://github.com/bvisible/mcp-ssh-manager) (MIT). See its
  [third-party notices](plugins/manual/ops-ssh-manager/THIRD_PARTY_NOTICES.md) and preserved
  [upstream license](plugins/manual/ops-ssh-manager/LICENSE-MCP-SSH-MANAGER).
- [`code-longwait-preset`](plugins/manual/code-longwait-preset/) is a minimally modified copy of DeepSeek Harness's
  shipped `code` agent preset: only the Job wait-limit configuration changes. The upstream MIT license is preserved
  in the [module](plugins/manual/code-longwait-preset/LICENSE).

## Community integrations

These projects are installed from and maintained by their upstream authors; this repository provides integration
recipes rather than vendoring their source.

- [`liustack/modlens`](https://github.com/liustack/modlens) provides the vision capability documented by the
  [`modlens-vision`](plugins/community/modlens-vision/) integration recipe. Modlens is MIT-licensed.

## Design and research references

The following projects helped establish the engineering landscape or informed design trade-offs. Unless a project is
also named in the "Vendored or adapted code" section above, this repository does not claim to include its source.

- Browser automation: [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp),
  [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), and
  [OpenCLI](https://github.com/jackwener/OpenCLI).
- Computer use: [QwenLM/open-computer-use](https://github.com/QwenLM/open-computer-use) and
  [OpenClaw](https://github.com/openclaw/openclaw).
- Cross-agent workflows: [yhlooo/dsh-bridges](https://github.com/yhlooo/dsh-bridges),
  [ZSeven-W/dsh-crew](https://github.com/ZSeven-W/dsh-crew),
  [`@monotykamary/dsh-subagent-claude-code`](https://www.npmjs.com/package/@monotykamary/dsh-subagent-claude-code),
  and [kky42/codex-as-mcp](https://github.com/kky42/codex-as-mcp).
- SSH operations: [Lynricsy/OneSSH](https://github.com/Lynricsy/OneSSH) and
  [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) informed host modeling, TOFU, privilege
  separation, and tool-contract trade-offs. Their source code is not included here.

## Foundation and trademarks

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) supplies the host primitives this repository
  extends and is licensed under MIT.
- Product and project names belong to their respective owners. Acknowledgement here does not imply sponsorship,
  endorsement, or affiliation.

If an attribution is incomplete or imprecise, please open an issue with the affected path and upstream source. We
will correct the record.
