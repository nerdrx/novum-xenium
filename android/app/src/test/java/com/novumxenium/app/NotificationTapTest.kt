package com.novumxenium.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationTapTest {
    @Test fun notificationCopyIsGenericAndUnknownKindsAreIgnored() {
        assertEquals("New email", NotificationCopy.forEvent("email", "success")?.first)
        assertEquals("Chat needs attention", NotificationCopy.forEvent("chat", "waiting_user")?.first)
        assertEquals("Task needs attention", NotificationCopy.forEvent("task", "error")?.first)
        assertNull(NotificationCopy.forEvent("unknown", "failure"))
        assertEquals("Open Novum to view it.", NotificationCopy.forEvent("email", "success")?.second)
    }

    @Test fun acceptsPositiveDecimalEventIds() {
        assertEquals("#notification-42", NotificationTap.route("42"))
    }

    @Test fun rejectsInvalidOrOversizedIds() {
        listOf(null, "", "0", "-2", "1/../2", "1234567890123456789").forEach {
            assertNull(NotificationTap.route(it))
        }
    }
}
