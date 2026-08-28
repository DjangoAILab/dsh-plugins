# Third-party notices

`dsh-notifier` is a vendored derivative of
[`THEWOLFWALKER/dsh-notifier@0.7.3`](https://github.com/THEWOLFWALKER/dsh-notifier), distributed under the MIT
License. The module-local [`LICENSE`](LICENSE) preserves its upstream copyright notice.

Parts of the channel-adapter request/response behavior were adapted and rewritten for this module from:

1. [`CaoMeiYouRen/push-all-in-one`](https://github.com/CaoMeiYouRen/push-all-in-one), MIT License.
   Its copyright and permission notice are reproduced in
   [`LICENSE-PUSH-ALL-IN-ONE`](LICENSE-PUSH-ALL-IN-ONE).
2. [`HCLonely/all-pusher-api`](https://github.com/HCLonely/all-pusher-api), Apache License 2.0. The upstream license
   is reproduced in [`LICENSE-APACHE-2.0`](LICENSE-APACHE-2.0). The upstream repository does not publish a non-empty
   NOTICE file.

The adapted areas are identified in source comments, including `src/adapters/_engine.mjs`,
`src/adapters/wecom-app.mjs`, `src/adapters/qq-bot.mjs`, and `src/adapters/spec-channels.mjs`.
