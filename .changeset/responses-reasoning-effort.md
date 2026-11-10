---
"@effect-uai/responses": patch
---

`reasoning.effort` accepts every value current models take: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` (`ReasoningEffort`). Type only. For `store: false`, request the encrypted reasoning yourself with `extraBody: { include: ["reasoning.encrypted_content"] }`; it isn't added automatically because models without reasoning reject it.
