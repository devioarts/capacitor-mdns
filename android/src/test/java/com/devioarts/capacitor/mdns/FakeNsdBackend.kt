package com.devioarts.capacitor.mdns

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher

/** FAILURE_ALREADY_ACTIVE from NsdManager (inlined constant, duplicated to keep the fake android-free). */
const val FAILURE_ALREADY_ACTIVE = 3

/**
 * Scriptable [NsdBackend]. Like the real NSD service it invokes listeners on threads of its own,
 * never on the (fake) main thread, which is exactly what the production code must cope with.
 */
internal class FakeNsdBackend(override val supportsConcurrentResolve: Boolean) : NsdBackend {

    // Registration
    @Volatile var registrationListener: NsdBackend.RegistrationListener? = null
    val registeredNames = CopyOnWriteArrayList<String>()
    val unregisterCalls = AtomicInteger()
    @Volatile var registerError: Throwable? = null

    // Discovery
    @Volatile var discoveryListener: NsdBackend.DiscoveryListener? = null
    val stopDiscoveryCalls = AtomicInteger()
    @Volatile var startDiscoveryError: Throwable? = null

    // Resolve
    val resolveCalls = CopyOnWriteArrayList<String>()
    val cancelResolveCalls = AtomicInteger()
    val alreadyActiveFailures = AtomicInteger()
    val maxConcurrentResolves = AtomicInteger()
    /** Number of upcoming resolve() calls that fail with FAILURE_ALREADY_ACTIVE (simulates a foreign resolve). */
    val forcedAlreadyActive = AtomicInteger()
    @Volatile var resolveDelayMs = 20L
    /** Returns the answer for a candidate, or null when the OS never calls back. */
    @Volatile var answer: (DiscoveredService) -> mDNS.MdnsService? =
        { s -> mDNS.MdnsService(s.name, s.type, listOf("10.0.0.1"), 8080) }

    private val inFlight = AtomicInteger()
    private val legacySlot = AtomicBoolean(false)

    // ---- Registration --------------------------------------------------------

    override fun registerService(type: String, name: String, port: Int, listener: NsdBackend.RegistrationListener): Any {
        registerError?.let { throw it }
        registrationListener = listener
        registeredNames += name
        return Any()
    }

    override fun unregisterService(token: Any) {
        unregisterCalls.incrementAndGet()
    }

    // ---- Discovery -----------------------------------------------------------

    override fun startDiscovery(type: String, listener: NsdBackend.DiscoveryListener): Any {
        startDiscoveryError?.let { throw it }
        discoveryListener = listener
        return Any()
    }

    override fun stopDiscovery(token: Any) {
        stopDiscoveryCalls.incrementAndGet()
    }

    // ---- Resolve -------------------------------------------------------------

    override fun resolve(service: DiscoveredService, listener: NsdBackend.ResolveListener): Any? {
        resolveCalls += service.name

        if (!supportsConcurrentResolve) {
            val forced = forcedAlreadyActive.getAndUpdate { if (it > 0) it - 1 else 0 } > 0
            if (forced || !legacySlot.compareAndSet(false, true)) {
                alreadyActiveFailures.incrementAndGet()
                background { listener.onFailed(FAILURE_ALREADY_ACTIVE) }
                return null
            }
        }

        val result = answer(service)
        if (result == null) {
            // The OS never answers. Do not hold the legacy slot hostage forever.
            legacySlot.set(false)
        } else {
            val now = inFlight.incrementAndGet()
            maxConcurrentResolves.accumulateAndGet(now) { a, b -> maxOf(a, b) }
            background {
                Thread.sleep(resolveDelayMs)
                inFlight.decrementAndGet()
                legacySlot.set(false)
                listener.onResolved(result)
            }
        }
        return if (supportsConcurrentResolve) Any() else null
    }

    override fun cancelResolve(token: Any) {
        cancelResolveCalls.incrementAndGet()
    }

    // ---- Test drivers --------------------------------------------------------

    fun fireRegistered(name: String) = background { registrationListener!!.onRegistered(name) }
    fun fireFound(name: String, type: String = "_http._tcp.") =
        background { discoveryListener!!.onFound(DiscoveredService(name, type)) }

    fun awaitDiscoveryListener() = await { discoveryListener != null }
    fun awaitRegistrationListener() = await { registrationListener != null }

    companion object {
        fun background(block: () -> Unit): Thread = Thread(block, "fake-nsd").also { it.start() }

        fun await(timeoutMs: Long = 2000, condition: () -> Boolean) {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (!condition()) {
                check(System.currentTimeMillis() < deadline) { "Timed out waiting for condition" }
                Thread.sleep(2)
            }
        }
    }
}

/** A single-thread executor standing in for Android's main thread. */
internal class FakeMainThread : MainThread {
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "fake-main").also { thread = it }
    }
    @Volatile private var thread: Thread? = null

    val dispatcher: CoroutineDispatcher = executor.asCoroutineDispatcher()

    override fun isCurrent(): Boolean = Thread.currentThread() === thread
    override fun post(block: () -> Unit) {
        executor.execute(block)
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
