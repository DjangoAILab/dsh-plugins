# Third-party notices

ops-ssh-manager contains adapted portions of
[bvisible/mcp-ssh-manager](https://github.com/bvisible/mcp-ssh-manager):

- the destructive-command regular expressions in src/policy.mjs, adapted from src/policy.js;
- the audit redaction and JSONL record-building behavior in src/audit.mjs, adapted from src/audit.js.

MCP SSH Manager is distributed under the MIT License. Its copyright and permission notice are reproduced in
[LICENSE-MCP-SSH-MANAGER](LICENSE-MCP-SSH-MANAGER), and the adapted files identify their source in comments.

The host model, execution/management separation, TOFU workflow, and tool-contract trade-offs were also informed by
[Lynricsy/OneSSH](https://github.com/Lynricsy/OneSSH) (GPL-3.0) and
[classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) (ISC). Those are design references; their
source code is not included in this module.
