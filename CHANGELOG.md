# Changelog

## [0.0.12](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.11...v0.0.12) (2026-09-15)


### Documentation

* adopt the house README style, add the missing MIT licence ([aa770f2](https://github.com/AraneaDev/Momus-MCP/commit/aa770f27a371b83e1b9558349ae8fa9bcbf159b3))
* adopt the house README style, add the missing MIT licence ([79d9086](https://github.com/AraneaDev/Momus-MCP/commit/79d9086d6cb8a42436d3689aed1d02705dcd164e))
* link the project site from the readme ([#38](https://github.com/AraneaDev/Momus-MCP/issues/38)) ([19bee5e](https://github.com/AraneaDev/Momus-MCP/commit/19bee5e8a8683c63b5a8f173fa47530669b0806f))
* link the README to the project page ([4b8b687](https://github.com/AraneaDev/Momus-MCP/commit/4b8b687451234d91975f7cab36d597b77802073d))
* name the Python half of DRIFT-005 ([#39](https://github.com/AraneaDev/Momus-MCP/issues/39)) ([b66a749](https://github.com/AraneaDev/Momus-MCP/commit/b66a749b71e9996c13af5001c86f10c7b535141b))
* normalise the badge row, self-host the coverage badge ([a10d91e](https://github.com/AraneaDev/Momus-MCP/commit/a10d91ea5889a0cad3752cb785561561c9c5d918))
* normalise the badge row, self-host the coverage badge ([91f1170](https://github.com/AraneaDev/Momus-MCP/commit/91f117073509a85698bc4436f5ab794deee5b80f))
* point the badge at the renamed /tools section ([#37](https://github.com/AraneaDev/Momus-MCP/issues/37)) ([84911ca](https://github.com/AraneaDev/Momus-MCP/commit/84911ca55e2097d720b9b3188a0572e057cfb43e))
* **readme:** credit the author and link the write-up ([#44](https://github.com/AraneaDev/Momus-MCP/issues/44)) ([32ec00e](https://github.com/AraneaDev/Momus-MCP/commit/32ec00e380e1966b4ac6edb942f84069ce56d067))


### Continuous integration

* cancel superseded runs and give every job a timeout ([#40](https://github.com/AraneaDev/Momus-MCP/issues/40)) ([223c9e6](https://github.com/AraneaDev/Momus-MCP/commit/223c9e64c657300c1fed1790ed8cb3fcc2efdecb))
* match the release branch by prefix, not by exact name ([#43](https://github.com/AraneaDev/Momus-MCP/issues/43)) ([74f7573](https://github.com/AraneaDev/Momus-MCP/commit/74f7573610e56acc295c4363be4a8cf17f881cbd))
* move off the actions still running on Node 20 ([#36](https://github.com/AraneaDev/Momus-MCP/issues/36)) ([46d2e2f](https://github.com/AraneaDev/Momus-MCP/commit/46d2e2f2824bb27d8b4cc744aba31bdc22cf826d))
* **release:** list the changelog sections the other tools use ([#45](https://github.com/AraneaDev/Momus-MCP/issues/45)) ([968a9ff](https://github.com/AraneaDev/Momus-MCP/commit/968a9ff5f90d96c225cb0df5721224218062fa5d))
* scope the concurrency group to the pull request, not the base branch ([#41](https://github.com/AraneaDev/Momus-MCP/issues/41)) ([012e489](https://github.com/AraneaDev/Momus-MCP/commit/012e489e80479ec42cc443ae2fe24db393305a23))
* skip re-verification steps on release-please PRs ([#42](https://github.com/AraneaDev/Momus-MCP/issues/42)) ([88680ec](https://github.com/AraneaDev/Momus-MCP/commit/88680ec15ab2ec8b15f2825e2a6b6220e9e79efe))

## [0.0.11](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.10...v0.0.11) (2026-08-19)


### Bug Fixes

* **server:** an unwritable parse cache must not fail the audit ([7d57d7a](https://github.com/AraneaDev/Momus-MCP/commit/7d57d7ae01c29df26202b55e52eb7eaad9226bfa))
* **server:** an unwritable parse cache must not fail the audit ([ebbf030](https://github.com/AraneaDev/Momus-MCP/commit/ebbf030d41114d00fb35bf61cb301e492be7279d))

## [0.0.10](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.9...v0.0.10) (2026-08-19)


### Features

* **server:** add audit_workspace and doctor_status (agent tool surface, phase 2) ([da991c6](https://github.com/AraneaDev/Momus-MCP/commit/da991c6d2ed4ccf1db58da74fd0596e2d15c62fb))
* **server:** add audit_workspace and doctor_status (agent tool surface, phase 2) ([739660b](https://github.com/AraneaDev/Momus-MCP/commit/739660b0d70f44ffe2e65d3f6687b6f8d6e1133c))
* **server:** add preview_issue_fix and apply_issue_fix (agent tool surface, phase 3) ([74b6850](https://github.com/AraneaDev/Momus-MCP/commit/74b68508113b097f60790ad07e26b0737ee41ffa))
* **server:** add preview_issue_fix and apply_issue_fix (phase 3, write surface) ([592ef58](https://github.com/AraneaDev/Momus-MCP/commit/592ef58a0861449c5f55fafa8cc43073116fe159))
* **server:** add resources and change notifications (agent tool surface, phase 4) ([228be7f](https://github.com/AraneaDev/Momus-MCP/commit/228be7ff38c38cbcd16ed2634ff38a670c8d79c8))
* **server:** add resources and change notifications (phase 4, final) ([bbdf0ac](https://github.com/AraneaDev/Momus-MCP/commit/bbdf0acdad49c2972623d64875469174d6126232))


### Bug Fixes

* **server:** detect a monorepo's tsconfig in doctor_status ([a9bc952](https://github.com/AraneaDev/Momus-MCP/commit/a9bc95268f29efa0434bef87294fb68e63ad30e8))

## [0.0.9](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.8...v0.0.9) (2026-08-19)


### Features

* **server:** add explain_issue and get_ir (agent tool surface, phase 1) ([2374da4](https://github.com/AraneaDev/Momus-MCP/commit/2374da42edb00fba076149f4409c94e42a659df3))
* **server:** add explain_issue and get_ir (agent tool surface, phase 1) ([8b8f04a](https://github.com/AraneaDev/Momus-MCP/commit/8b8f04a7e4eea83710684f2d7c63da526df468e3))

## [0.0.8](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.7...v0.0.8) (2026-08-18)


### Features

* add mock_derive, mocktopus, galvanic detection and python hardening ([6ed6392](https://github.com/AraneaDev/Momus-MCP/commit/6ed6392747822333335706f2fd8f42cbd1a81ee6))


### Bug Fixes

* close 25 dogfood false positives across Chaos, Knossos and Argos ([1e2c682](https://github.com/AraneaDev/Momus-MCP/commit/1e2c682cb9f0d90d4e675b8b340ef4be3ccf6eac))
* close 25 dogfood false positives across Chaos, Knossos and Argos ([1770ec5](https://github.com/AraneaDev/Momus-MCP/commit/1770ec5f723dd80d0629bee4864e9fbf21f5bc2e))

## [0.0.7](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.6...v0.0.7) (2026-08-17)


### Features

* close mockall TAUT-005 false positives + src-layout DRIFT-005 fix ([0532694](https://github.com/AraneaDev/Momus-MCP/commit/0532694e7bdd078bd33466fce9674c1a5a530a31))
* close mockall TAUT-005 false positives, fix src-layout DRIFT-005 ([c0177db](https://github.com/AraneaDev/Momus-MCP/commit/c0177db05f83b2b28bc67f7e1fb8834811677599))

## [0.0.6](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.5...v0.0.6) (2026-08-17)


### Features

* derive mock-of-self subject per language ([71b53ee](https://github.com/AraneaDev/Momus-MCP/commit/71b53eee45e7883d7dd5ceb243c6787b702a1e5b))
* four-language parity (pyright inference + cross-language rules + 4-language synthesis) ([843b694](https://github.com/AraneaDev/Momus-MCP/commit/843b694509fb2e6518b9fd994dddd5e23a0a23e1))
* **parser-python:** pyright type inference for unannotated signatures ([fff1e5e](https://github.com/AraneaDev/Momus-MCP/commit/fff1e5e8dddc9f4535324bc00a9aebb5940ef691))
* **parser-rust:** trace wrapper re-bindings and by-value mock consumption ([dbb7c39](https://github.com/AraneaDev/Momus-MCP/commit/dbb7c3950ab7b42dd54a81667eeb97bd53ebd885))
* PHP TAUT-006 for unconfigured Mockery spies ([75853a9](https://github.com/AraneaDev/Momus-MCP/commit/75853a9f01c246c86008999fc9486bfbdd36c9d1))
* Python DRIFT-005 for patch of a missing module attribute ([70b891f](https://github.com/AraneaDev/Momus-MCP/commit/70b891fa2b57eb2ff686be3b67ab33d9378dbadd))
* Python TAUT-006 for unconfigured assert_called mocks ([16de8bf](https://github.com/AraneaDev/Momus-MCP/commit/16de8bf05febf21327ceef82c92bb3a9b69e71e8))
* synthesize pytest/unittest and mockall/mockito/wiremock contracts ([657c6d9](https://github.com/AraneaDev/Momus-MCP/commit/657c6d92047f49467406e86c8bb1d8f72083fdf5))


### Bug Fixes

* include rs in watcher and ignore Python/Rust build dirs ([20c9cc8](https://github.com/AraneaDev/Momus-MCP/commit/20c9cc86bf35e97a3e1e936b830fec3bed545cdc))

## [0.0.5](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.4...v0.0.5) (2026-08-17)


### Features

* **core:** register rust language + mockall/mockito/wiremock IR members ([882f8db](https://github.com/AraneaDev/Momus-MCP/commit/882f8dbde6799d8fb6e1b747295d7d185f74b2a2))
* **parser-rust:** assertions + provenance ([415e382](https://github.com/AraneaDev/Momus-MCP/commit/415e38210dab787cd97c9accadcf220112296610))
* **parser-rust:** crate-wide use/mod path resolution ([7dd1211](https://github.com/AraneaDev/Momus-MCP/commit/7dd1211d26e7075f31765393a14d58a9159b6c68))
* **parser-rust:** mockall automock/mock! detection with expect_ configs ([5340fb8](https://github.com/AraneaDev/Momus-MCP/commit/5340fb80cbe19a008cb45b17a6181c80bf44e723))
* **parser-rust:** mockito/wiremock HTTP mock detection ([91f66bd](https://github.com/AraneaDev/Momus-MCP/commit/91f66bdc83b03c5c6ce9a90b8fa61a8c194b5f45))
* **parser-rust:** rustReturnAssignable + DRIFT-001/003 wiring ([f85738d](https://github.com/AraneaDev/Momus-MCP/commit/f85738dc598020ade059e52e6403909e741a96c4))
* **parser-rust:** symbols, imports, and structural test detection ([dd2e8e5](https://github.com/AraneaDev/Momus-MCP/commit/dd2e8e56eb79a095087e1529c049ed0c08170798))
* **parser-rust:** syn-&gt;wasm32 wrapper and synchronous loader ([d5c5372](https://github.com/AraneaDev/Momus-MCP/commit/d5c53723aedd71cad042cdabc3479f3c4cf72d04))
* Rust language support (syn → WASM) ([4722773](https://github.com/AraneaDev/Momus-MCP/commit/4722773a092d2668cb843b28f7063545a8522ee4))
* wire Rust parser into CLI/server/doctor + golden/MCP tests ([17649c5](https://github.com/AraneaDev/Momus-MCP/commit/17649c569b070999cde1102ecc53050c3eb4287b))


### Bug Fixes

* **parser-rust:** eliminate mockall dogfood false positives ([c4867e3](https://github.com/AraneaDev/Momus-MCP/commit/c4867e3b094fcb1956f48c7c7116cd3c3870dd77))

## [0.0.4](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.3...v0.0.4) (2026-08-17)


### Features

* **parser-python:** annotated DRIFT-001/003 drift detection ([130dd2e](https://github.com/AraneaDev/Momus-MCP/commit/130dd2ef99cc48952a2525b77cf32fa7988fffb2))
* **parser-python:** assertions, provenance, and reachability ([941443f](https://github.com/AraneaDev/Momus-MCP/commit/941443fdf1031e0f83b7888149c898adf36acea8))
* **parser-python:** scaffold package with validated tree-sitter helpers ([05f86c9](https://github.com/AraneaDev/Momus-MCP/commit/05f86c92fcec333d757b5fb7adb4558c7b1ec876))
* **parser-python:** symbols, imports, and test detection ([e847c77](https://github.com/AraneaDev/Momus-MCP/commit/e847c775b02936820f21ccc4a92d97f81e1264be))
* **parser-python:** unittest.mock / pytest-mock / monkeypatch detection ([5c3349d](https://github.com/AraneaDev/Momus-MCP/commit/5c3349d9853c219e01062a736853672b63b1a35b))
* Python language support (tree-sitter-python + annotations-first drift) ([88add30](https://github.com/AraneaDev/Momus-MCP/commit/88add307a1e4068f1d78320550107e3b9e81cccb))
* wire python language support through CLI, server, doctor, and release tooling ([afe97f8](https://github.com/AraneaDev/Momus-MCP/commit/afe97f8ac387ac315417a0c50f470c79102cb754))


### Bug Fixes

* **parser-python:** make assertion extraction linear, not quadratic ([524c9f2](https://github.com/AraneaDev/Momus-MCP/commit/524c9f28d3db4647a4e973962943fa7787456995))

## [0.0.3](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.2...v0.0.3) (2026-08-17)


### Bug Fixes

* ignore docs/.vitepress/dist in ESLint ([77c3a8c](https://github.com/AraneaDev/Momus-MCP/commit/77c3a8c53b1e7f4d61148c1adf6155c3d1ae1250))

## [0.0.2](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.1...v0.0.2) (2026-08-16)


### Bug Fixes

* keep release-please on patch bumps pre-1.0 so ~ dep ranges resolve ([d197f1b](https://github.com/AraneaDev/Momus-MCP/commit/d197f1be868206892bf28466926bf68f5a749680))
