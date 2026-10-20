# Write, reply to and send email

This guide covers the browser Email library and its compose panel. Mailbox
setup lives in [Connected services](features-connected-services.md#email); this
page explains what the compose and recovery controls do.

## Choose a mailbox

Open **Email** from the left rail (or `/email`). In the Email library, choose
the account chip for the mailbox you want, then use the folder picker to open
**Inbox**, **Drafts**, or another folder. The active chip selects the mailbox
used for reading and is also the account the composer tries to use when
sending. Account setup and default-account controls are in **Settings →
Integrations**.

The composer has no separate **From** picker. If Novum detects that the selected mailbox is
receive-only, it warns and uses the server's send-capable fallback: the
default account is preferred, then another permitted, enabled send-capable account may be
used. That can change the sender address. If sender identity matters, resolve
the account configuration in Integrations before sending. If no send-capable
account exists, correct the configuration before retrying.

## Start a message or reply

- Choose **new** beside Email in the left rail, or **New** in the Email
  library, to start a message.
- Open a message and choose its reply action to start a reply. The composer
  carries the source message's reply headers and recipients into the draft.
- Choose **Cc** in the composer to reveal the Cc and Bcc fields.
- When viewing the **Drafts** folder, open a draft to resume editing that
  message. Novum opens it as a compose draft; it does not create a reply to the
  draft.

Review To, Cc, Bcc, subject, body, attachments, and active mailbox. Use the
arrow beside **Send** and choose **Save Draft** to save a copy to the mailbox's
Drafts folder. **Close** is not the Save Draft action; save first if you need a
mailbox copy you can reopen later.

## What recovery saves

When you press **Send**, Novum first tries to save the message to the mailbox
as a recovery draft. If that save fails or times out, sending is cancelled;
the app reports that it could not save a recovery draft. If the later send
fails, the app reports the failure and says the draft is kept in Drafts. Check
that folder before trying again.

Replies may also keep a best-effort browser-local recovery copy tied to the
source message. It is separate from the mailbox Drafts folder: it is stored in
this browser's local storage, applies only to source-linked replies, omits
attachments, and expires after 45 days. Storage can be unavailable, so do not
rely on it as your only copy. Use **Save Draft** for a mailbox copy.

## Send carefully

**Send** submits the message to the configured mail service. It is an external
action, not a preview, and Novum cannot recall a message after the service has
accepted it. Check the selected account and recipients before clicking it.

After a successful send, Novum also attempts to add the To, Cc and Bcc
recipients to the configured contacts backend (CardDAV).

After a successful send, Novum reports **Message sent**. That confirms the
configured SMTP operation reported success; it cannot prove that the recipient
received or read the message. If the browser loses its connection after you
press **Send**, the result may be unclear. Check **Sent** and **Drafts** (and,
for important messages, confirm with the recipient) before retrying, because a
second send can create a duplicate.

## If something goes wrong

- **No mailbox appears:** ask an administrator to add or repair the account in
  **Settings → Integrations**. Email accounts are separate from chat model
  providers.
- **The selected account is receive-only:** choose the intended send-capable
  account chip or ask the administrator to configure its SMTP/OAuth settings.
  When the composer detects a receive-only selection, it warns and the server
  chooses a permitted send-capable fallback (default first, then another enabled
  account may be used).
- **Save Draft fails or times out:** keep the composer open, check the mailbox
  connection/account, then use **Save Draft** again. Confirm the draft appears
  in **Drafts** before closing if you need a durable mailbox copy.
- **Send reports failure:** open **Drafts** and inspect the recovery copy. If
  the connection failed after Send began, inspect **Sent** too before another
  attempt; the server may have accepted the send even if the browser did not
  receive its result.
- **Reply headers or text look wrong:** do not send yet. Check the recipients,
  subject, and reply text against the source message, then save a mailbox draft
  before closing if you need to keep your edits.

For provider setup and detailed server behavior, see the [email account and
transport reference](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/specs/email-contacts.md).

## Source checked for this guide

These links point to the inspected source snapshot at commit
`c5e165b5fd0be15a56ed0c3abfcb661ba7690c54`:

- [Email entry points and compose controls](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/static/index.html#L869-L875), [account chips and folders](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/static/js/emailLibrary/index.js#L2882-L2985), and [compose fields and Send/Save Draft actions](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/static/js/document.js#L7526-L7558).
- [Draft mailbox opens as a compose draft](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/static/js/emailInbox.js#L903-L907) and [library draft loading](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/static/js/emailLibrary/index.js#L5589-L5598).
- [Browser-local reply recovery and 45-day expiry](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/static/js/document.js#L3453-L3529), [send-account resolution](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/static/js/document.js#L96-L123), and [mailbox recovery before send plus error handling](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/static/js/document.js#L6260-L6305).
- [Send request and recovery-draft status handling](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/static/js/document.js#L6361-L6411), [server SMTP result / queued-send behavior](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/routes/email/email_routes.py#L5670-L5683), and [SMTP account fallback plus delivery wait behavior](https://github.com/nerdrx/novum-xenium/blob/c5e165b5fd0be15a56ed0c3abfcb661ba7690c54/routes/email/email_routes.py#L1498-L1529).
