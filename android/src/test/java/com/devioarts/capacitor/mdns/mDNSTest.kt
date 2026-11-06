package com.devioarts.capacitor.mdns

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
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
        resolveTimeoutMs: Long = 5000,
        stopTimeoutMs: Long = 3000
    ): Rig {
        val backend = FakeNsdBackend(concurrentResolve)
        val main = FakeMainThread()
        val mdns = mDNS(backend, main, main.dispatcher, null, publishTimeoutMs, resolveTimeoutMs, stopTimeoutMs)
        cleanups += { runBlocking { mdns.stopWatching() }; main.shutdown() }
        return Rig(backend, main, mdns)
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

    @Test
    fun stopBroadcast_waitsForConfirmationAndReleasesTheLockOnce() {
        val r = rig()
        val probe = r.broadcast()
        r.backend.awaitRegistrationListener()
        r.backend.fireRegistered("Svc")
        FakeNsdBackend.await { probe.successes.size == 1 }
        r.backend.autoUnregister = false
        val results = CopyOnWriteArrayList<Pair<Boolean, Throwable?>>()
        r.mdns.stopBroadcast { publishing, error -> results += publishing to error }
        FakeNsdBackend.await { r.backend.unregisterCalls.get() == 1 }
        assertTrue(results.isEmpty())
        assertEquals(1, r.backend.multicastLocks.get())
        r.backend.registrationListener!!.onUnregistered()
        FakeNsdBackend.await { results.size == 1 }
        assertEquals(false to null, results.single())
        assertEquals(0, r.backend.multicastLocks.get())
        r.mdns.stopBroadcast { publishing, error -> results += publishing to error }
        FakeNsdBackend.await { results.size == 2 }
        assertEquals(1, r.backend.lockReleases.get())
    }

    @Test
    fun stopBroadcast_failuresKeepTheRegistrationAndPreventReplacement() {
        for (throws in listOf(true, false)) {
            val r = rig()
            val probe = r.broadcast()
            r.backend.awaitRegistrationListener()
            r.backend.fireRegistered("Svc")
            FakeNsdBackend.await { probe.successes.size == 1 }
            if (throws) r.backend.unregisterError = IllegalStateException("stop failed")
            else r.backend.unregistrationErrorCode = 7
            val results = CopyOnWriteArrayList<Pair<Boolean, Throwable?>>()
            r.mdns.stopBroadcast { publishing, error -> results += publishing to error }
            FakeNsdBackend.await { results.size == 1 }
            assertTrue(results.single().first)
            assertTrue(results.single().second != null)
            val replacement = r.broadcast("B")
            FakeNsdBackend.await { replacement.errors.size == 1 }
            assertEquals(listOf("Svc"), r.backend.registeredNames.toList())
            assertEquals(0, r.backend.multicastLocks.get())
            r.backend.unregisterError = null
            r.backend.unregistrationErrorCode = null
            r.mdns.stopBroadcast { publishing, error -> results += publishing to error }
            FakeNsdBackend.await { results.size == 2 }
            assertEquals(false to null, results.last())
            assertEquals(0, r.backend.multicastLocks.get())
        }
    }

    @Test
    fun stopBroadcast_timeoutRetainsRegistrationUntilLateConfirmation() {
        val r = rig(stopTimeoutMs = 40)
        val probe = r.broadcast()
        r.backend.awaitRegistrationListener()
        r.backend.fireRegistered("Svc")
        FakeNsdBackend.await { probe.successes.size == 1 }
        r.backend.autoUnregister = false
        val results = CopyOnWriteArrayList<Pair<Boolean, Throwable?>>()
        r.mdns.stopBroadcast { publishing, error -> results += publishing to error }
        FakeNsdBackend.await { results.size == 1 }
        assertTrue(results.single().first)
        assertTrue(results.single().second!!.message!!.contains("Timed out"))
        assertEquals(0, r.backend.multicastLocks.get())
        r.backend.registrationListener!!.onUnregistered()
        FakeNsdBackend.await { r.backend.multicastLocks.get() == 0 }
        r.mdns.stopBroadcast { publishing, error -> results += publishing to error }
        FakeNsdBackend.await { results.size == 2 }
        assertEquals(false to null, results.last())
        assertEquals(1, r.backend.unregisterCalls.get())
    }

    @Test
    fun broadcast_replacementWaitsUntilTheOldRegistrationIsRemoved() {
        val r = rig()
        val first = r.broadcast("A")
        r.backend.awaitRegistrationListener()
        val old = r.backend.registrationListener!!
        val second = r.broadcast("B")
        FakeNsdBackend.await { first.errors.size == 1 }
        assertEquals(listOf("A"), r.backend.registeredNames.toList())
        r.backend.autoUnregister = false
        old.onRegistered("A")
        FakeNsdBackend.await { r.backend.unregisterCalls.get() == 1 }
        assertEquals(listOf("A"), r.backend.registeredNames.toList())
        old.onUnregistered()
        FakeNsdBackend.await { r.backend.registeredNames.size == 2 }
        r.backend.fireRegistered("B")
        FakeNsdBackend.await { second.successes.size == 1 }
        assertEquals(1, r.backend.multicastLocks.get())
        r.backend.autoUnregister = true
        r.mdns.stopBroadcast()
        FakeNsdBackend.await { r.backend.multicastLocks.get() == 0 }
    }

    @Test
    fun multicastLock_isSharedByOverlappingDiscoveryAndBroadcast() {
        val r = rig()
        val probe = r.broadcast()
        r.backend.awaitRegistrationListener()
        r.backend.fireRegistered("Svc")
        FakeNsdBackend.await { probe.successes.size == 1 }
        FakeNsdBackend.background {
            r.backend.awaitDiscoveryListener()
            assertEquals(2, r.backend.multicastLocks.get())
            r.backend.fireFound("A")
        }
        discover(r, name = "A")
        assertEquals(1, r.backend.multicastLocks.get())
        r.mdns.stopBroadcast()
        FakeNsdBackend.await { r.backend.multicastLocks.get() == 0 }
        assertEquals(r.backend.lockAcquires.get(), r.backend.lockReleases.get())
    }

    @Test
    fun multicastLock_isReleasedOnStartFailuresAndPublishTimeout() {
        val r = rig(publishTimeoutMs = 40)
        r.backend.registerError = IllegalStateException("register failed")
        val failed = r.broadcast()
        FakeNsdBackend.await { failed.errors.size == 1 }
        assertEquals(0, r.backend.multicastLocks.get())
        r.backend.startDiscoveryError = IllegalStateException("discovery failed")
        try { discover(r); fail("expected failure") } catch (_: IllegalStateException) {}
        assertEquals(0, r.backend.multicastLocks.get())
        r.backend.registerError = null
        val timedOut = r.broadcast()
        FakeNsdBackend.await { timedOut.errors.size == 1 && r.backend.multicastLocks.get() == 0 }
        r.backend.fireRegistered("Svc")
        FakeNsdBackend.await { r.backend.unregisterCalls.get() == 1 }
        assertEquals(r.backend.lockAcquires.get(), r.backend.lockReleases.get())
    }

    @Test
    fun stopBroadcast_pendingRegistrationTimesOutAndStillCleansUpLateSuccess() {
        val r = rig(stopTimeoutMs = 40)
        val probe = r.broadcast()
        r.backend.awaitRegistrationListener()
        val results = CopyOnWriteArrayList<Pair<Boolean, Throwable?>>()
        r.mdns.stopBroadcast { publishing, error -> results += publishing to error }
        FakeNsdBackend.await { results.size == 1 }
        assertTrue(results.single().first)
        assertTrue(results.single().second!!.message!!.contains("Timed out"))
        assertEquals(1, probe.errors.size)
        assertEquals(0, r.backend.unregisterCalls.get())
        assertEquals(0, r.backend.multicastLocks.get())
        r.backend.fireRegistered("Svc")
        FakeNsdBackend.await { r.backend.unregisterCalls.get() == 1 }
        assertEquals(1, r.backend.lockReleases.get())
    }

    @Test
    fun close_releasesTheLockEvenWhenStopIsNeverConfirmed() {
        val r = rig(stopTimeoutMs = 40)
        val probe = r.broadcast()
        r.backend.awaitRegistrationListener()
        r.backend.fireRegistered("Svc")
        FakeNsdBackend.await { probe.successes.size == 1 }
        r.backend.autoUnregister = false
        val completed = CopyOnWriteArrayList<Boolean>()
        r.mdns.close { completed += true }
        FakeNsdBackend.await { completed.isNotEmpty() }
        assertEquals(0, r.backend.multicastLocks.get())
        r.backend.registrationListener!!.onUnregistered()
        assertEquals(1, r.backend.lockReleases.get())
    }

    @Test
    fun multicastLock_isReleasedWhenDiscoveryIsCancelled() = runBlocking {
        val r = rig()
        val discovery = launch(r.main.dispatcher) { r.mdns.discover("_http._tcp.", timeoutMs = 8000) }
        r.backend.awaitDiscoveryListener()
        assertEquals(1, r.backend.multicastLocks.get())
        discovery.cancel()
        discovery.join()
        assertEquals(0, r.backend.multicastLocks.get())
        assertEquals(1, r.backend.stopDiscoveryCalls.get())
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

    private class WatchProbe : mDNS.WatchListener {
        val found = CopyOnWriteArrayList<mDNS.MdnsService>()
        val lost = CopyOnWriteArrayList<mDNS.MdnsService>()
        val errors = CopyOnWriteArrayList<Pair<String, Boolean>>()
        override fun onServiceFound(service: mDNS.MdnsService) {
            assertEquals("fake-main", Thread.currentThread().name)
            found += service
        }
        override fun onServiceLost(service: mDNS.MdnsService) { lost += service }
        override fun onError(type: String, message: String, watching: Boolean) { errors += message to watching }
    }

    @Test
    fun watch_normalizesTypesAndReturnsFullSnapshotsOnLoss() = runBlocking {
        val r = rig()
        val probe = WatchProbe()
        assertEquals(2, r.mdns.watchServices(listOf(" _http._tcp", "_http._tcp.", "_ipp._tcp."), probe))
        r.backend.answer = { s -> mDNS.MdnsService(s.name, s.type, emptyList(), 80, mapOf("role" to "test")) }
        val listener = r.backend.discoveryListeners.getValue("_http._tcp.")
        FakeNsdBackend.background { repeat(3) { listener.onFound(DiscoveredService("A", "_http._tcp")) } }
        FakeNsdBackend.await { probe.found.size == 1 }
        FakeNsdBackend.background { listener.onLost(DiscoveredService("A", "_http._tcp")) }
        FakeNsdBackend.await { probe.lost.size == 1 }
        assertEquals(probe.found.single(), probe.lost.single())
        assertEquals(emptyList<String>(), probe.lost.single().hosts)
        assertEquals(mapOf("role" to "test"), probe.lost.single().txt)
        assertEquals(1, r.backend.multicastLocks.get())
        assertEquals(null, r.mdns.stopWatching())
        assertEquals(0, r.backend.multicastLocks.get())
    }

    @Test
    fun watch_ignoresLateResolveAfterLossStopAndReplacement() = runBlocking {
        val r = rig()
        val probe = WatchProbe()
        r.backend.resolveDelayMs = 150
        r.mdns.watchServices(listOf("_http._tcp."), probe)
        val old = r.backend.discoveryListeners.getValue("_http._tcp.")
        old.onFound(DiscoveredService("Lost", "_http._tcp."))
        FakeNsdBackend.await { r.backend.resolveCalls.size == 1 }
        old.onLost(DiscoveredService("Lost", "_http._tcp."))
        Thread.sleep(200)
        assertTrue(probe.found.isEmpty())
        assertTrue(probe.lost.isEmpty())
        old.onFound(DiscoveredService("Stopped", "_http._tcp."))
        FakeNsdBackend.await { r.backend.resolveCalls.size == 2 }
        r.mdns.stopWatching()
        r.mdns.watchServices(listOf("_ipp._tcp."), probe)
        old.onFound(DiscoveredService("Stale", "_http._tcp."))
        Thread.sleep(200)
        assertTrue(probe.found.isEmpty())
        assertEquals(2, r.backend.resolveCalls.size)
    }

    @Test
    fun watch_andDiscoverShareLegacyResolverAndSeparateLocks() = runBlocking {
        val r = rig(concurrentResolve = false)
        val probe = WatchProbe()
        r.backend.resolveDelayMs = 60
        r.mdns.watchServices(listOf("_http._tcp."), probe)
        val watcher = r.backend.discoveryListeners.getValue("_http._tcp.")
        watcher.onFound(DiscoveredService("Watched", "_http._tcp."))
        val discovery = launch {
            val services = r.mdns.discover("_ipp._tcp.", timeoutMs = 400)
            assertEquals(listOf("Once"), services.map { it.name })
        }
        FakeNsdBackend.background {
            FakeNsdBackend.await { r.backend.discoveryListeners.containsKey("_ipp._tcp.") }
            r.backend.discoveryListeners.getValue("_ipp._tcp.").onFound(DiscoveredService("Once", "_ipp._tcp."))
        }
        discovery.join()
        assertEquals(1, probe.found.size)
        assertEquals(1, r.backend.maxConcurrentResolves.get())
        assertEquals(0, r.backend.alreadyActiveFailures.get())
        assertEquals(1, r.backend.multicastLocks.get())
    }

    @Test
    fun watch_retriesResolveAndAllowsRediscoveryAfterExhaustion() = runBlocking {
        val r = rig(concurrentResolve = false)
        val probe = WatchProbe()
        r.backend.forcedAlreadyActive.set(4)
        r.mdns.watchServices(listOf("_http._tcp."), probe)
        val listener = r.backend.discoveryListeners.getValue("_http._tcp.")
        listener.onFound(DiscoveredService("A", "_http._tcp."))
        FakeNsdBackend.await { probe.errors.size == 1 }
        assertTrue(probe.errors.single().second)
        listener.onFound(DiscoveredService("A", "_http._tcp."))
        FakeNsdBackend.await { probe.found.size == 1 }
    }

    @Test
    fun watch_invalidReplacementKeepsExistingWatchAndBrowserFailureStopsIt() = runBlocking {
        val r = rig()
        val probe = WatchProbe()
        r.mdns.watchServices(listOf("_http._tcp."), probe)
        val listener = r.backend.discoveryListeners.getValue("_http._tcp.")
        for (types in listOf(emptyList(), listOf(" "), listOf("http"))) {
            try { r.mdns.watchServices(types, probe); fail("expected invalid types to fail") }
            catch (_: IllegalArgumentException) {}
        }
        assertEquals(listener, r.backend.discoveryListeners.getValue("_http._tcp."))
        listener.onStartFailed(2)
        FakeNsdBackend.await { probe.errors.size == 1 }
        assertEquals(false, probe.errors.single().second)
        assertEquals(0, r.backend.multicastLocks.get())
    }

    @Test
    fun watch_stopFailureIsReportedAndRetriedWithoutLateEvents() = runBlocking {
        val r = rig()
        val probe = WatchProbe()
        r.mdns.watchServices(listOf("_http._tcp."), probe)
        val listener = r.backend.discoveryListeners.getValue("_http._tcp.")
        r.backend.stopDiscoveryError = IllegalStateException("stop failed")
        assertEquals("stop failed", r.mdns.stopWatching()?.message)
        listener.onFound(DiscoveredService("Late", "_http._tcp."))
        Thread.sleep(30)
        assertTrue(probe.found.isEmpty())
        r.backend.stopDiscoveryError = null
        assertEquals(null, r.mdns.stopWatching())
        assertTrue(r.backend.discoveryListeners.isEmpty())
    }

    @Test
    fun watch_stopDoesNotStopBroadcastAndCloseReleasesBothLocks() = runBlocking {
        val r = rig()
        r.broadcast()
        r.backend.awaitRegistrationListener()
        r.backend.fireRegistered("Svc")
        r.mdns.watchServices(listOf("_http._tcp."), WatchProbe())
        assertEquals(2, r.backend.multicastLocks.get())
        r.mdns.stopWatching()
        assertEquals(0, r.backend.unregisterCalls.get())
        assertEquals(1, r.backend.multicastLocks.get())
        r.mdns.watchServices(listOf("_http._tcp."), WatchProbe())
        r.mdns.close()
        FakeNsdBackend.await { r.backend.multicastLocks.get() == 0 }
    }

    @Test
    fun watch_waitsForStopConfirmationAndRetriesAsyncFailureOrTimeout() = runBlocking {
        val r = rig(stopTimeoutMs = 60)
        r.mdns.watchServices(listOf("_http._tcp."), WatchProbe())
        r.backend.stopDiscoveryErrorCode = 7
        assertEquals("Discovery failed to stop: 7", r.mdns.stopWatching()?.message)
        r.backend.stopDiscoveryErrorCode = null
        r.backend.autoStopDiscovery = false
        assertTrue(r.mdns.stopWatching()?.message!!.contains("Timed out"))
        r.backend.autoStopDiscovery = true
        assertEquals(null, r.mdns.stopWatching())
        assertTrue(r.backend.discoveryListeners.isEmpty())
    }

    @Test
    fun watch_concurrentReplacementsLeaveExactlyOneBrowserGroup() = runBlocking {
        val r = rig()
        r.backend.stopDiscoveryDelayMs = 30
        r.mdns.watchServices(listOf("_http._tcp."), WatchProbe())
        val first = async { r.mdns.watchServices(listOf("_ipp._tcp."), WatchProbe()) }
        val second = async { r.mdns.watchServices(listOf("_test._udp."), WatchProbe()) }
        first.await()
        second.await()
        assertEquals(setOf("_test._udp."), r.backend.discoveryListeners.keys.toSet())
        assertEquals(1, r.backend.multicastLocks.get())
    }

    @Test
    fun watch_ignoresLateCallbacksFromTimedOutResolveAttempts() = runBlocking {
        val r = rig(resolveTimeoutMs = 80)
        val probe = WatchProbe()
        r.backend.answer = { null }
        r.mdns.watchServices(listOf("_http._tcp."), probe)
        r.backend.discoveryListeners.getValue("_http._tcp.").onFound(DiscoveredService("A", "_http._tcp."))
        FakeNsdBackend.await { r.backend.resolveListeners.size == 2 }
        r.backend.resolveListeners[0].onFailed(1)
        r.backend.resolveListeners[0].onResolved(mDNS.MdnsService("Stale", "_http._tcp.", emptyList(), 1))
        Thread.sleep(10)
        assertTrue(probe.found.isEmpty())
        r.backend.resolveListeners[1].onResolved(mDNS.MdnsService("A", "_http._tcp.", emptyList(), 80))
        FakeNsdBackend.await { probe.found.size == 1 }
        assertEquals("A", probe.found.single().name)
    }

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
