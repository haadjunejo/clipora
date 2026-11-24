# Security

## Keep your keys safe
Clipora runs **on your own machine or notebook** — your videos, keys and tokens never go to the Clipora authors.
- Put keys in Kaggle/Colab **Secrets** or a `clipora.env` file inside a **private** dataset. Never in a public
  dataset, a screenshot, an issue, or a commit.
- Always set `APP_PASSWORD` when the site has a public link — otherwise anyone with the link can use your GPU and
  your connected social accounts.
- Tokens shown by *Save it as a secret* (YouTube / Facebook) work like passwords for posting to your accounts.
- YouTube `cookies.txt` is a login: use a spare Google account and keep the file private.
- If a key leaks, revoke it at the provider (Groq / Google AI Studio / Google Cloud / Meta) and create a new one.

## Reporting a vulnerability
Please **don't open a public issue** for security problems. Use GitHub's
**Security → Report a vulnerability** (private advisory) on this repository. You'll get a reply as soon as possible.
