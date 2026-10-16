package com.novumxenium.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushNoticeTest {
    @Test fun contentAlwaysUsesGenericCopyAndKeepsServerBinding() {
        val notice = PushNotice.from(
            mapOf(
                "event_id" to "42",
                "kind" to "email",
                "server_id" to "instance_1",
                "title" to "private subject",
                "body" to "private email body",
            ),
        )

        assertEquals("42", notice?.eventId)
        assertEquals("instance_1", notice?.serverId)
        assertEquals("New email", notice?.title)
        assertEquals("You have new email.", notice?.body)
    }

    @Test fun rejectsInvalidEventOrServerIdsAndKinds() {
        val valid = mapOf("event_id" to "42", "kind" to "task", "server_id" to "instance_1")
        assertNull(PushNotice.from(valid + ("event_id" to "0")))
        assertNull(PushNotice.from(valid - "server_id"))
        assertNull(PushNotice.from(valid + ("kind" to "unknown")))
    }

    @Test fun failureCopyDoesNotIncludeEventDetails() {
        val notice = PushNotice.from(
            mapOf("event_id" to "42", "kind" to "task", "server_id" to "instance_1", "status" to "failure"),
        )

        assertEquals("Task needs attention", notice?.title)
        assertEquals("A task did not finish successfully.", notice?.body)
    }

    @Test fun approvalNeededCopyDoesNotClaimTheResponseIsReady() {
        val notice = PushNotice.from(
            mapOf("event_id" to "43", "kind" to "chat", "server_id" to "instance_1", "status" to "waiting_approval"),
        )

        assertEquals("Response needs attention", notice?.title)
        assertEquals("Open Novum Xenium to review a request.", notice?.body)
    }
}
