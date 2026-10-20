# Documents, notes, and memory

Novum includes document, notes, task, calendar, email, and memory tools, but which ones appear depends on configuration and permissions. This page explains the safe way to use them without implying that every connector is already connected.

## Documents and files

Keep source files in the intended workspace or attach them in the chat when the interface offers that option. Tell the agent which file is authoritative and what output you expect. Review generated documents in their saved location and open them in the application that will use them. A successful text response does not prove the exported file is complete or visually correct.

The desktop workspace supports native save dialogs for downloads. Browser and Android file access follows their client and server behavior; it does not grant access to arbitrary files on the host.

## Notes and knowledge

Notes and persistent knowledge are stored through their own features, not merely because something appeared in a chat. Ask the agent to confirm the destination and title before saving sensitive or long-lived information. Search and memory tools may return excerpts; open the source conversation or note when exact wording or context matters.

Treat retrieved text like any other untrusted source. It may contain stale instructions or errors. It cannot grant permissions, and it does not replace checking the current source of truth.

## Chat history and retrieval

Past-chat recall can find matching messages with timestamps and source links. Large tool outputs may be archived so a useful chunk can be searched and reopened. Retrieval saves context space; it does not make a model's context unlimited or ensure every prior detail is found.

The context inspector can show how the current context is being used. Token counts and provider limits may be estimates or unknown. If an old chat is important, open the cited messages rather than relying on a short summary.

## Skills

Skills are reusable procedures that can load on demand. The interface distinguishes **All**, **Built-in**, **Approved**, and **Draft**. Approved status reflects the recorded publication/audit rules described in the [skills lifecycle source](https://github.com/nerdrx/novum-xenium/blob/main/docs/skills-lifecycle.md); it is not a guarantee that a procedure is suitable for every request. Review the skill's content and permissions before using it.

## External connectors

Email, calendar, and other connected services can act on external data. Confirm the selected account, target, and exact operation before an irreversible action. A connected service may have its own permission scope; app-level chat permissions do not replace the service's account controls.
