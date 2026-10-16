package com.novumxenium.app

internal object NotificationCopy {
    fun forEvent(kind: String, status: String): Pair<String, String>? {
        val needsAttention = status.lowercase() in setOf(
            "error", "failure", "failed", "attention", "waiting_user", "ask_user",
        )
        return when (kind) {
            "email" -> "New email" to "Open Novum to view it."
            "chat" -> if (needsAttention) "Chat needs attention" to "Open Novum to review the result."
                else "Chat complete" to "Open Novum to view the result."
            "task" -> if (needsAttention) "Task needs attention" to "Open Novum to review the result."
                else "Task update" to "Open Novum to view the result."
            else -> null
        }
    }
}
