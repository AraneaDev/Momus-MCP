# Changelog

## [0.1.0](https://github.com/AraneaDev/Momus-MCP/compare/v0.0.1...v0.1.0) (2026-08-16)


### Features

* derive type-appropriate mock return values in contract synthesis ([0504b57](https://github.com/AraneaDev/Momus-MCP/commit/0504b5739ca327af2a5895e1cbc4da303c88a45f))
* establish Momus-MCP test integrity auditor ([066ac32](https://github.com/AraneaDev/Momus-MCP/commit/066ac3247a720d1bf38b9b9222653d0678f61fd5))
* ship PHP support, git-diff scoping, and distribution scaffolding ([0f09dfa](https://github.com/AraneaDev/Momus-MCP/commit/0f09dfad26458b890b48c609bc6d6a48626c3cf6))
* **synth:** resolve named interface/class returns to data-shape literals ([bfd06b0](https://github.com/AraneaDev/Momus-MCP/commit/bfd06b00a003f4ee62f973245dabb5697c9f1d7b))


### Bug Fixes

* add jsonpath to release-please json extra-files ([ccc535f](https://github.com/AraneaDev/Momus-MCP/commit/ccc535ffd3668b87c93329b6b5d5547fe6ce567b))
* correct CLI flag parsing and DRIFT-005 export checks found via real-codebase test ([33b9847](https://github.com/AraneaDev/Momus-MCP/commit/33b9847bdb73c3747c51affa8f4fc88ace8850d3))
* count SUT instances, helper calls, and it.each tests as production (TAUT-004) ([bf360e1](https://github.com/AraneaDev/Momus-MCP/commit/bf360e1014c1a3679c30b998bb94183d0c17145d))
* **php:** mark mocks handed off via constructor/call/return as reachable ([f5f1669](https://github.com/AraneaDev/Momus-MCP/commit/f5f16697c8c716288ec57830a6946987731ed98f))
* **php:** use loc.source for operand text to stop false self-comparisons ([f08bec6](https://github.com/AraneaDev/Momus-MCP/commit/f08bec69c61c592c49dd2924f765e1395a75b000))
* recompute drift summary counts and derive mockResolvedValue for promises ([1620215](https://github.com/AraneaDev/Momus-MCP/commit/1620215ded4ad61757544f58612b4e0e87d46a0d))
* refine TAUT-001/TAUT-006 reachability and add typed-generic synthesis ([24b371c](https://github.com/AraneaDev/Momus-MCP/commit/24b371cb8290359f6a3a2c37b97b062d5af12c98))
* scope-aware TS mock reachability and PHP/config validation hardening ([151f5d6](https://github.com/AraneaDev/Momus-MCP/commit/151f5d671d0ab4085f6df4033b4a0a9e2b1c1f9e))
* **synth:** resolve string-literal union aliases to real members ([c0a1a11](https://github.com/AraneaDev/Momus-MCP/commit/c0a1a11885c011773f8f85fe5953a99ae04fb35e))
* **synth:** support interfaces and concretize generic type parameters ([08a6c9f](https://github.com/AraneaDev/Momus-MCP/commit/08a6c9f42b267c8d491dd77991d6d1ab6b425f89))
* **ts:** count dynamic import() as exercising production code (TAUT-004) ([7bf1f20](https://github.com/AraneaDev/Momus-MCP/commit/7bf1f20709a398cec6c7ae1e3d7813d123237304))
