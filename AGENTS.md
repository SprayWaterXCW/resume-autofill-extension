# Resume Agent workspace boundary

- This directory is the standalone Resume Agent project. Keep Agent code, tests, documentation, and synthetic evaluation reports here.
- The Chrome extension is maintained separately in `../FORMFILL_RESEARCH/1lck/AI-Resume-Form-Filling-Assistant-master`. Do not edit that directory or other projects under `../FORMFILL_RESEARCH` while working on this Agent.
- Never perform a job application submission, resume submission, registration, or equivalent final action. Saving a draft is a separate capability that needs an explicit, verified implementation.
- Use fictional profile data for development and evaluation. Do not put API keys or real resume values in source, logs, traces, or reports.
- Real Chrome acceptance must use the existing user profile and model configuration. The user authorizes refreshing the current recruitment tab during testing without asking again; after a refresh, start the run with the normal "开始填写此标签页" button. Do not prefill fields, run a preparatory scan, or add test-specific configuration. Later user instructions about preserving edits take precedence.
