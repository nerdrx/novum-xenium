# Install and start your first chat

This is the supported quick path for a self-hosted Docker Compose installation. It uses the repository defaults: the web app listens on localhost port `7000`, authentication is enabled, and application state is stored under `data/`.

## You need

- Git
- Docker Engine with the Compose plugin (`docker compose`)
- A machine that can run the backend containers

The desktop app manages an existing checkout; it does not install Docker, WSL, or Git for you. Windows and macOS users can run the documented Compose setup using Docker Desktop. Linux GPU passthrough is optional; start with CPU or an already-running provider.

## Start the server

Run these commands in a terminal:

```sh
git clone https://github.com/nerdrx/novum-xenium.git
cd novum-xenium
cp .env.example .env
docker compose up -d --build
```

The first build downloads dependencies and may take several minutes. When it finishes, open [http://localhost:7000](http://localhost:7000).

If you configured `ODYSSEUS_ADMIN_PASSWORD` before the first boot, use it. Otherwise, the initial temporary password is printed by the application container:

```sh
docker compose logs odysseus
```

If you cannot reach the page, confirm the containers started with `docker compose ps` and follow [Startup and loading](troubleshooting/startup.md). Do not publish the default port directly to the public internet; read [Trust and data boundaries](reference/security.md) before allowing network access.

## Connect a model

1. Sign in and open a chat.
2. Open the model picker and select **+** (**Add model endpoints**).
3. Follow [Add a model provider](tutorials/provider.md) to enter a local or hosted endpoint, test it, and add it.
4. Return to the model picker, select the added model, and send a small prompt such as “Reply with the word ready.”
5. If it fails, record the provider name, model name, and visible error, then use [Providers and models](providers.md).

Choose **Agent** when you intend to use tools. A regular chat asks the model to answer without the agent's tool workflow. Tool availability also depends on settings, mode, and permissions.

## Where your data lives

With the default Compose setup, application data is persisted in the repository's `data/` directory. Project files are stored in `data/agent_workspace/workspace/` and mounted in the application container at `/workspace`. Keep backups private: they can contain chats, documents, provider credentials, and other sensitive application data. Read [Back up before an update](tutorials/backup-update.md) before moving or replacing persistent data.

## Stop and start

From the repository directory:

```sh
docker compose stop
docker compose start
```

`stop` preserves containers and data. To see the current state, use `docker compose ps`. For normal shutdown, do not remove volumes or delete the `data/` directory.

## Further setup

- [Desktop manager](desktop.md) for managing a checkout, logs, backups, and updates.
- [Providers and models](providers.md) for local and hosted inference choices.
- [Configuration and administration](reference/configuration.md) for deployment settings.
- Canonical setup notes in the [repository README](https://github.com/nerdrx/novum-xenium#readme).
