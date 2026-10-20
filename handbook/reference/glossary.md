# Glossary

| Term | Meaning in this handbook |
| --- | --- |
| Agent | A chat mode in which the model can use enabled tools. Exact tools depend on settings and permissions. |
| Backend | The Novum application service and its persistent data, typically run with Docker Compose. |
| Compose checkout | The repository directory whose Compose files the desktop manager operates. |
| Context | The bounded information and tool definitions available to a model for a run. Retrieval can reuse information but does not make context unlimited. |
| Executor | Optional separate Docker container used for Bash/Python commands. Its state and environment differ from the app container. |
| GGUF | A model file format used by some local text and image model runtimes. Compatibility depends on the runtime and model type. |
| MCP | Model Context Protocol, a way to connect external tool servers. Connected tools use their own permissions. |
| Model provider | A local server or hosted service that performs model inference. |
| Snapshot | A bounded copy of eligible workspace files for restore. It does not undo external side effects. |
| zVram | Experimental Vulkan allocation management that can page eligible allocations into system memory under supported conditions. It adds no physical VRAM and may be slow. |
