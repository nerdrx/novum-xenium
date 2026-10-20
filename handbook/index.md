# Novum Xenium Handbook

Novum Xenium is a self-hosted workspace for chats, models, files, and tools. The browser, desktop manager, and Android companion connect to the same backend and saved data. This handbook explains how to set it up, use common workflows, and recover from common problems.

Start with [Install and first chat](getting-started.md) if you are new. If something is broken, use [First checks](troubleshooting/index.md) and then follow the symptom guide.

## Find a guide

| I want to… | Start here |
| --- | --- |
| Install the server and send a first message | [Install and first chat](getting-started.md) |
| Add a hosted or local model | [Providers and models](providers.md) |
| Download, resume, and launch local models | [Cookbook and local models](cookbook.md) |
| Research a question and follow a saved report | [Deep Research](research.md) |
| Compare model and search-provider responses | [Compare models](compare.md) |
| Understand chat modes, tools, and approvals | [Tools, modes, and approvals](tools-safety.md) |
| Keep files and coding work organized | [Chats and workspaces](chats-workspaces.md) |
| Work with notes, documents, and memory | [Documents, notes, and memory](knowledge.md) |
| Configure calendar, email, modules, MCP, and Android | [Connected services](features-connected-services.md) |
| Schedule recurring work | [Tasks and notifications](tasks.md) |
| Back up before an update | [Back up before an update](tutorials/backup-update.md) |
| Configure deployment, accounts, API tokens, and storage | [Configuration and administration](reference/configuration.md) |
| Fix startup or provider loading | [Troubleshooting](troubleshooting/index.md) |
| Find exact feature limits and source documents | [Feature and source index](reference/index.md) |

## Read this first

- Novum Xenium is a fork of [Odysseus](https://github.com/odysseus-dev/odysseus). Its original authorship and AGPL license remain credited.
- Self-hosting the app does not make a hosted model local. The provider you choose receives the data sent with your request.
- “Full access” remains inside the configured workspace and container. It does not grant extra host access or enable disabled tools.
- Local model support depends on platform, provider, driver, model, and available memory. A model appearing in a list does not prove it will load or fit.
- This handbook is maintained with the source. Controls can change between releases; check the app version and linked source when a screen differs.

## About this handbook

The guide is organized around the jobs a user needs to complete: setup, daily use, safe tool execution, maintenance, and recovery. See the [coverage map](reference/coverage.md) for the documented workflows, platform limits, and exact areas that still need hands-on confirmation.

The static handbook is searchable and works on mobile. To contribute, edit Markdown under `handbook/`; the Pages workflow checks the build before publishing.
