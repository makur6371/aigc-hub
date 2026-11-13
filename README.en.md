<p align="center">
  <img src="docs/assets/aigc-hub-banner.svg" width="920" alt="AIGC Hub — self-hosted AI creation workspace">
</p>

<p align="center">
  <a href="https://github.com/makur6371/aigc-hub/actions/workflows/verify.yml"><img alt="CI" src="https://github.com/makur6371/aigc-hub/actions/workflows/verify.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache%202.0-7352bc"></a>
  <a href="docs/deploy.md"><img alt="Self-host with Docker Compose" src="https://img.shields.io/badge/deploy-Docker%20Compose-2874b5"></a>
</p>

# AIGC Hub

**Bring your own models to a self-hosted AI creation workspace.** Create and edit images, generate video, chat with an agent, and build reusable node workflows. The default installation has no configured model providers.

[简体中文](README.md) · [Deployment guide (中文)](docs/deploy.md) · [Contributing (中文)](CONTRIBUTING.md)

- **Create:** prompt-to-image, reference image editing, and video generation. Video settings follow the selected model's capabilities.
- **Agent:** streaming chat and configurable task planning.
- **Canvas and tools:** connect nodes, run workflows, and save, import, or export them.
- **Results and administration:** track jobs, recover results, manage assets, configure models and quotas, and inspect usage.

## Homepage preview

![AIGC Hub homepage with its creation bar, canvas, and toolbox links](docs/assets/home-preview.webp)

<details>
<summary>View the typing animation</summary>

![Example prompts are typed and erased](docs/assets/home-typing.gif)

The creation bar cycles through example prompts and opens the workspace when selected.

</details>

## Run the local demo

Install Node.js 24 and npm, then run:

```sh
git clone https://github.com/makur6371/aigc-hub.git
cd aigc-hub
npm ci
```

Copy `.env.example` to `.env`. Set `JWT_SECRET` to a random value at least 32 characters long, provide `BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` (at least 12 characters and at most 72 bytes), and set `APP_ENABLE_DEMO=1`.

```sh
npm run db:setup -- --demo
npm run dev
```

Open [the workspace](http://localhost:3000), sign in, and select a local demo model in Create. The demo uses bundled sample media and text; it needs no API key.

For a real installation, run `npm run db:setup` without `--demo` and configure your providers in System Settings. Use [Docker Compose](docs/deploy.md) for a persistent installation. The current app expects persistent SQLite and file storage and is not a one-click Vercel deployment.

## License and attribution

[Apache License 2.0](LICENSE). Keep the applicable [NOTICE](NOTICE) when redistributing. Third-party dependencies retain their own licenses. A link back to AIGC Hub in your site's About page is welcome.

Report vulnerabilities privately following the [security policy](SECURITY.md).
