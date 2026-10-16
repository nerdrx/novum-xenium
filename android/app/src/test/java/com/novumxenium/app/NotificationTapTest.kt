package com.novumxenium.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationTapTest {
    @Test fun acceptsPositiveDecimalEventIds() {
        assertEquals("#notification-42", NotificationTap.route("42"))
    }

    @Test fun rejectsInvalidOrOversizedIds() {
        listOf(null, "", "0", "-2", "1/../2", "1234567890123456789").forEach {
            assertNull(NotificationTap.route(it))
        }
    }
}
