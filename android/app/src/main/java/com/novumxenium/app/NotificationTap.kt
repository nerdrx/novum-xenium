package com.novumxenium.app

/** Accept only opaque numeric event IDs before using them to build an internal hash route. */
internal object NotificationTap {
    fun eventId(eventId: String?): String? {
        if (eventId.isNullOrEmpty() || eventId.length > 18 || eventId.any { !it.isDigit() }) return null
        val number = eventId.toLongOrNull() ?: return null
        return number.takeIf { it > 0 }?.toString()
    }

    fun route(eventId: String?): String? = eventId(eventId)?.let { "#notification-$it" }
}
