# Security

noxeval sends your eval cases and your app's answers to the judge you configure (TypeSafe, OpenAI or any compatible server). Don't put secrets or personal data in case files, and keep API keys in environment variables, never in `noxeval.config.mjs`.

`noxeval.config.mjs` is JavaScript and runs with your permissions. Only run configs you trust.

To report a vulnerability, use [GitHub's private vulnerability reporting](https://github.com/marcusrdrigues/noxeval/security/advisories/new) instead of a public issue.
