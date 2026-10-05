package com.devioarts.capacitor.mdns

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class mDNSTest {

    private val cleanups = mutableListOf<() -> Unit>()

    @After
    fun tearDown() = cleanups.forEach { it() }

    private class Rig(val backend: FakeNsdBackend, val main: FakeMainThread, val mdns: mDNS)

    private fun rig(
        concurrentResolve: Boolean = true,
        publishTimeoutMs: Long = 5000,
        resolveTimeoutMs: Long = 5000
    ): Rig {
        val backend = FakeNsdBackend(concurrentResolve)
        val main = FakeMainThread()
        cleanups += { main.shutdown() }
        return Rig(backend, main, mDNS(backend, main, main.dispatcher, null, publishTimeoutMs, resolveTimeoutMs))
    }

    /** Collects the outcomes of one broadcast() call. */
    private class BroadcastProbe {
        val successes = CopyOnWriteArrayList<String>()
        val errors = CopyOnWriteArrayList<Throwable>()
        val calls get() = successes.size + errors.size
    }

    private fun Rig.broadcast(name: String = "Svc"): BroadcastProbe {
        val probe = BroadcastProbe()
        mdns.broadcast("_http._tcp", name, 8080, { probe.successes += it }, { probe.errors += it })
        return probe
    }

    private fun discover(r: Rig, name: String? = null, timeoutMs: Int = 400) = runBlocking {
        withTimeout(10_000) { r.mdns.discover("_http._tcp", name, timeoutMs) }
    }

    // ---- broadcast -----------------------------------------------------------

    @Test
    fun broadcast_reportsPublishedNameFromBackgroundCallback() {
        val r = rig()
        val probe = r.broadcast()
        r.backend.awaitRegistrationListener()
        r.backend.fireRegistered("Svc (2)")
        FakeNsdBackend.await { probe.calls == 1 }
        assertEquals(listOf("Svc (2)"), probe.successes.toList())
        assertTrue(probe.errors.isEmpty())
    }

    @Test
    fun broadcast_invalidPortIsRejectedSynchronously() {
        val r = rig()
        try {
            r.mdns.broadcast("_http._tcp", "x", 0, {}, {})
            fail("expected IllegalArgumentException")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun broadcast_backendFailureIsReportedAsError() {
        val r = rig()
        r.backend.registerError = IllegalStateException("boom")
        val probe = r.broadcast()
        FakeNsdBackend.await { probe.calls == 1 }
        assertEquals("boom", probe.errors.single().message)
    }

    @Test
    fun broadcast_registrationRaceWithTimeoutCompletesExactlyOnce() {
        // Confirmation from the NSD thread lands right around the publish timeout.
        repeat(40) {
            val r = rig(publishTimeoutMs = 15)
            val probe = r.broadcast()
            r.backend.awaitRegistrationListener()
            FakeNsdBackend.background {
                Thread.sleep(14)
                r.backend.registrationListener!!.onRegistered("Svc")
            }
            FakeNsdBackend.await { probe.calls >= 1 }
            Thread.sleep(40) // give a duplicate completion the chance to show up
            assertEquals("completed more than once on iteration $it", 1, probe.calls)
        }
    }

    @Test
    fun broadcast_timeoutReportsErrorAndUndoesLateConfirmation() {
        val r = rig(publishTimeoutMs = 50)
        val probe = r.broadcast()
        FakeNsdBackend.await { probe.errors.size == 1 }
        assertTrue(probe.errors.single().message!!.contains("Timed out"))
        assertEquals(0, r.backend.unregisterCalls.get())

        // The OS confirms after we already told JS it failed: the service must not stay advertised.
        r.backend.fireRegistered("Svc")
        FakeNsdBackend.await { r.backend.unregisterCalls.get() == 1 }
        assertEquals(0, probe.successes.size)
    }

    @Test
    fun broadcast_replacedRequestFailsThePreviousPromise() {
        val r = rig()
        val first = r.broadcast("A")
        r.backend.awaitRegistrationListener()
        val second = r.broadcast("B")
        FakeNsdBackend.await { first.errors.size == 1 }
        assertTrue(first.errors.single().message!!.contains("Replaced"))
        assertEquals(0, second.calls)
    }

    @Test
    fun stopBroadcast_beforeConfirmationDefersUnregisterUntilTheOsConfirms() {
        val r = rig()
        val probe = r.broadcast()
        r.backend.awaitRegistrationListener()

        r.mdns.stopBroadcast()
        FakeNsdBackend.await { probe.errors.size == 1 }
        assertEquals("unregistering an unconfirmed registration is unsafe", 0, r.backend.unregisterCalls.get())

        r.backend.fireRegistered("Svc")
        FakeNsdBackend.await { r.backend.unregisterCalls.get() == 1 }
        assertEquals(0, probe.successes.size)
    }

    @Test
    fun stopBroadcast_afterConfirmationUnregistersImmediately() {
        val r = rig()
        val probe = r.broadcast()
        r.backend.awaitRegistrationListener()
        r.backend.fireRegistered("Svc")
        FakeNsdBackend.await { probe.successes.size == 1 }

        r.mdns.stopBroadcast()
        FakeNsdBackend.await { r.backend.unregisterCalls.get() == 1 }
        r.mdns.stopBroadcast() // idempotent
        Thread.sleep(30)
        assertEquals(1, r.backend.unregisterCalls.get())
    }

    @Test
    fun close_failsPendingBroadcast() {
        val r = rig()
        val probe = r.broadcast()
        r.backend.awaitRegistrationListener()
        r.mdns.close()
        FakeNsdBackend.await { probe.errors.size == 1 }
    }

    // ---- discover ------------------------------------------------------------

    @Test
    fun discover_returnsResolvedServicesAfterTimeout() {
        val r = rig()
        val job = FakeNsdBackend.background {
            r.backend.awaitDiscoveryListener()
            r.backend.fireFound("A")
            r.backend.fireFound("B")
        }
        val result = discover(r, timeoutMs = 300)
        job.join()
        assertEquals(setOf("A", "B"), result.map { it.name }.toSet())
        assertEquals(1, r.backend.stopDiscoveryCalls.get())
        assertEquals("candidates seen twice must resolve once", 2, r.backend.resolveCalls.size)
    }

    @Test
    fun discover_duplicateCandidatesAreResolvedOnce() {
        val r = rig()
        FakeNsdBackend.background {
            r.backend.awaitDiscoveryListener()
            repeat(5) { r.backend.fireFound("A") }
        }
        val result = discover(r, timeoutMs = 250)
        assertEquals(1, result.size)
        assertEquals(1, r.backend.resolveCalls.size)
    }

    @Test
    fun discover_targetPrefixMatchesSuffixedNameAndExitsEarly() {
        val r = rig()
        FakeNsdBackend.background {
            r.backend.awaitDiscoveryListener()
            r.backend.fireFound("Other")
            r.backend.fireFound("Foo (2)")
        }
        val started = System.currentTimeMillis()
        val result = discover(r, name = "Foo", timeoutMs = 5000)
        assertTrue("should exit early, took ${System.currentTimeMillis() - started}ms",
            System.currentTimeMillis() - started < 2500)
        assertEquals(listOf("Foo (2)"), result.map { it.name })
        assertEquals("non-matching candidates are never resolved", listOf("Foo (2)"), r.backend.resolveCalls.toList())
        assertEquals(1, r.backend.stopDiscoveryCalls.get())
    }

    @Test
    fun discover_startFailureIsReported() {
        val r = rig()
        r.backend.startDiscoveryError = IllegalStateException("nope")
        try {
            discover(r)
            fail("expected exception")
        } catch (e: IllegalStateException) {
            assertEquals("nope", e.message)
        }
    }

    @Test
    fun discover_stateIsNotSharedBetweenRuns() {
        val r = rig()
        FakeNsdBackend.background { r.backend.awaitDiscoveryListener(); r.backend.fireFound("A") }
        assertEquals(listOf("A"), discover(r, timeoutMs = 200).map { it.name })

        r.backend.discoveryListener = null
        FakeNsdBackend.background { r.backend.awaitDiscoveryListener(); r.backend.fireFound("B") }
        assertEquals(listOf("B"), discover(r, timeoutMs = 200).map { it.name })
    }

    @Test
    fun discover_callbacksFromManyThreadsDoNotCorruptState() {
        // Regression for NSD callbacks arriving off the main thread while the timeout reads results.
        repeat(5) {
            val r = rig()
            r.backend.resolveDelayMs = 1
            val threads = (0 until 4).map { t ->
                FakeNsdBackend.background {
                    r.backend.awaitDiscoveryListener()
                    repeat(60) { i ->
                        r.backend.discoveryListener!!.onFound(DiscoveredService("S-$t-$i", "_http._tcp."))
                    }
                }
            }
            val result = discover(r, timeoutMs = 150)
            threads.forEach { it.join() }
            assertTrue(result.all { it.name.startsWith("S-") })
            assertEquals("no duplicates expected", result.size, result.map { it.name }.toSet().size)
        }
    }

    // ---- legacy (pre API 34) resolve ----------------------------------------

    @Test
    fun legacyResolve_isSerializedSoNoServiceIsLost() {
        val r = rig(concurrentResolve = false)
        r.backend.resolveDelayMs = 30
        FakeNsdBackend.background {
            r.backend.awaitDiscoveryListener()
            listOf("A", "B", "C").forEach { r.backend.fireFound(it) }
        }
        val result = discover(r, timeoutMs = 1500)
        assertEquals(setOf("A", "B", "C"), result.map { it.name }.toSet())
        assertEquals(1, r.backend.maxConcurrentResolves.get())
        assertEquals(0, r.backend.alreadyActiveFailures.get())
    }

    @Test
    fun legacyResolve_retriesWhenTheSlotIsTakenByAnotherCaller() {
        val r = rig(concurrentResolve = false)
        r.backend.forcedAlreadyActive.set(2)
        FakeNsdBackend.background { r.backend.awaitDiscoveryListener(); r.backend.fireFound("A") }
        val result = discover(r, timeoutMs = 2500)
        assertEquals(listOf("A"), result.map { it.name })
        assertEquals(2, r.backend.alreadyActiveFailures.get())
    }

    @Test
    fun legacyResolve_hangingResolveDoesNotBlockTheQueue() {
        val r = rig(concurrentResolve = false, resolveTimeoutMs = 60)
        r.backend.answer = { s -> if (s.name == "Stuck") null else mDNS.MdnsService(s.name, s.type, listOf("10.0.0.2"), 80) }
        FakeNsdBackend.background {
            r.backend.awaitDiscoveryListener()
            r.backend.fireFound("Stuck")
            Thread.sleep(10)
            r.backend.fireFound("Fine")
        }
        val result = discover(r, timeoutMs = 1500)
        assertEquals(listOf("Fine"), result.map { it.name })
    }

    // ---- close ---------------------------------------------------------------

    @Test
    fun close_failsPendingDiscoverInsteadOfHanging() {
        val r = rig()
        FakeNsdBackend.background {
            r.backend.awaitDiscoveryListener()
            Thread.sleep(30)
            r.mdns.close()
        }
        try {
            discover(r, timeoutMs = 8000)
            fail("expected exception")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("closed"))
        }
        assertEquals(1, r.backend.stopDiscoveryCalls.get())
    }
}
