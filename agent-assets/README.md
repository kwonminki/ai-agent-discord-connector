# Vendored agent instructions

These files are pinned, unmodified upstream sources. The connector reads its local copies; it does not download skills at runtime. `sources.json` records each repository, commit, file path, and SHA-256 checksum. The checksum test detects changes to the raw files.

| Source | Pinned commit | Included material | Upstream license information |
| --- | --- | --- | --- |
| [alexgreensh/attention-span](https://github.com/alexgreensh/attention-span/tree/2714c965e6be1fa2597510e66651e63bc67cb448/skills) | `2714c965e6be1fa2597510e66651e63bc67cb448` | All four `skills/*/SKILL.md` files | AGPL-3.0; original [LICENSE](vendor/attention-span/LICENSE) included |
| [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills/tree/2c606141936f1eeef17fa3043a72095b4765b9c2) | `2c606141936f1eeef17fa3043a72095b4765b9c2` | `karpathy-guidelines/SKILL.md`, `CLAUDE.md`, `EXAMPLES.md`, `README.md` | Skill frontmatter declares `license: MIT`; this revision has no standalone LICENSE file |
| [obra/superpowers](https://github.com/obra/superpowers/tree/8ca22dba9a94f28898bbce59f2537ff4d87c747d) | `8ca22dba9a94f28898bbce59f2537ff4d87c747d` | `verification-before-completion/SKILL.md` | MIT; original [LICENSE](vendor/superpowers/LICENSE) included |

The connector's MIT license does not replace the licenses of these third-party files. Preserve the accompanying license texts, attribution, and source information when distributing them.

Runtime copies live under the Worker's `.connect/agent-guidance/<digest>/`. The raw instruction files remain unchanged. The Claude output-style adapter removes skill frontmatter and adds output-style frontmatter with `keep-coding-instructions: true`; generated `AGENTS.md` links only the selected files.

The active catalog does **not** include anti-slop. Its proposed Python adaptation is described separately, with no Python lint configuration, CI rule, or agent skill installed.

See [usage and extension guide](../docs/agent-guidance.ko.md).
