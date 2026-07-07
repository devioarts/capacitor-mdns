package com.devioarts.capacitor.mdns
// English-only code and comments.

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicReference

/**
 * Thin Android NSD (Bonjour/mDNS) wrapper used by the Capacitor bridge.
 *
 * Responsibilities:
 * - Register/unregister (advertise/stop) a single service.
 * - Discover services of a given type and resolve them to host/port.
 * - Optional exact-or-prefix name filter (iOS-like behavior, handles " (n)" suffix).
 * - Timebox discovery; early-exit when the target match is resolved.
 *
 * Threading:
 * - All public APIs are main-thread safe. Calls hop to the main looper internally,
 *   since NSD APIs deliver callbacks on the main thread and expect a looper.
 *
 * Platform notes:
 * - Android NSD has no public API for TXT records.
 */
class mDNS(
    context: Context,
    private val externalScope: CoroutineScope? = null
) {
    private companion object {
        const val PUBLISH_TIMEOUT_MS = 5000L
    }

    /** Normalized service representation returned to the bridge. */
    data class MdnsService(
        val name: String,
        val type: String,
        val hosts: List<String>, // numeric addresses (v4/v6)
        val port: Int
    )

    private class RegistrationSession(
        val listener: NsdManager.RegistrationListener,
        val timeoutJob: Job,
        val onSuccess: (String) -> Unit,
        val onError: (Throwable) -> Unit
    ) {
        var completed = false
    }

    /** NSD system service. */
    private val nsd: NsdManager =
        context.getSystemService(Context.NSD_SERVICE) as NsdManager

    /** Keep strong references to listeners so they outlive registration/discovery. */
    private var activeRegistration: RegistrationSession? = null
    private val discListenerRef = AtomicReference<NsdManager.DiscoveryListener?>(null)

    /** Optional external scope (from plugin); otherwise create our own on Main. */
    private val scope = externalScope ?: CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val discoverMutex = Mutex()

    /** Main looper utilities for non-suspending entry points. */
    private val mainHandler = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor { command -> mainHandler.post(command) }
    private inline fun runOnMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() === Looper.getMainLooper()) block() else mainHandler.post { block() }
    }

    /**
     * Start advertising a service. If already registered, the previous one is unregistered first.
     *
     * @param typeRaw Service type; trailing dot appended if missing (e.g., "_http._tcp.")
     * @param name    Instance name; OS may append " (n)" to ensure uniqueness.
     * @param port    TCP port (> 0).
     * @param onSuccess Called with the (potentially uniquified) registered name.
     * @param onError   Called on registration failure.
     */
    fun broadcast(
        typeRaw: String,
        name: String,
        port: Int,
        onSuccess: (String) -> Unit,
        onError: (Throwable) -> Unit
    ) {
        require(port in 1..65535) { "Port must be between 1 and 65535" }
        val type = if (typeRaw.endsWith(".")) typeRaw else "$typeRaw."

        runOnMain {
            try {
                // Restarting while publish is pending must complete the old JS promise.
                stopActiveRegistration("Replaced by a new broadcast request")

                val info = NsdServiceInfo().apply {
                    serviceType = type
                    serviceName = name
                    setPort(port)
                }

                lateinit var session: RegistrationSession
                val listener = object : NsdManager.RegistrationListener {
                    override fun onServiceRegistered(nsi: NsdServiceInfo) =
                        completeRegistrationSuccess(session, nsi.serviceName)

                    override fun onRegistrationFailed(nsi: NsdServiceInfo, errorCode: Int) =
                        completeRegistrationError(
                            session,
                            IllegalStateException("Registration failed: $errorCode"),
                            clearActive = true
                        )

                    override fun onServiceUnregistered(nsi: NsdServiceInfo) { /* no-op */ }
                    override fun onUnregistrationFailed(nsi: NsdServiceInfo, errorCode: Int) { /* no-op */ }
                }

                val timeoutJob = scope.launch {
                    delay(PUBLISH_TIMEOUT_MS)
                    runOnMain {
                        completeRegistrationError(
                            session,
                            IllegalStateException("Timed out waiting for service publish after ${PUBLISH_TIMEOUT_MS}ms"),
                            clearActive = true,
                            unregister = true
                        )
                    }
                }

                session = RegistrationSession(listener, timeoutJob, onSuccess, onError)
                activeRegistration = session
                try {
                    nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
                } catch (t: Throwable) {
                    completeRegistrationError(session, t, clearActive = true)
                }
            } catch (t: Throwable) {
                onError(t)
            }
        }
    }

    /**
     * Stop advertising the currently registered service (if any). Safe to call multiple times.
     */
    fun stopBroadcast() {
        runOnMain {
            stopActiveRegistration("Publish stopped before completion")
        }
    }

    /**
     * Discover services, optionally filtering by instance name using a normalized exact-or-prefix match.
     *
     * Behavior:
     * - Runs on the main dispatcher.
     * - Resolves candidates to host/port.
     * - If `targetName` is provided, compare using normalized names and accept exact OR prefix match.
     * - Early-exits when a matching service is resolved (stops discovery immediately).
     * - Otherwise returns what was found when `timeoutMs` elapses.
     *
     * @param typeRaw     Service type; trailing dot appended if missing.
     * @param targetName  Optional instance name for normalized exact/prefix match.
     * @param timeoutMs   Timebox for discovery+resolve.
     * @return List of resolved services accumulated (or early-exit match).
     */
    suspend fun discover(
        typeRaw: String,
        targetName: String? = null,
        timeoutMs: Int = 3000
    ): List<MdnsService> = discoverMutex.withLock { withContext(Dispatchers.Main.immediate) {
        val type = if (typeRaw.endsWith(".")) typeRaw else "$typeRaw."

        // Prepare state
        discListenerRef.getAndSet(null)?.let { safeStopDiscovery(it) }
        val found = mutableListOf<MdnsService>()
        val serviceInfoCallbacks = mutableListOf<NsdManager.ServiceInfoCallback>()
        val result = CompletableDeferred<List<MdnsService>>()

        // Normalization for "(n)" suffix appended by the OS.
        fun normalize(s: String): String = s.replace(Regex(" \\(\\d+\\)\$"), "")
        fun matchesTarget(candidate: String): Boolean {
            val c = normalize(candidate)
            val t = normalize(targetName ?: return true) // if no target, accept all
            return (c == t) || c.startsWith(t)
        }
        fun upsert(item: MdnsService) {
            val index = found.indexOfFirst { it.name == item.name && it.type == item.type && it.port == item.port }
            if (index >= 0) found[index] = item else found.add(item)
        }
        fun unregisterServiceInfoCallbacks() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
            serviceInfoCallbacks.toList().forEach { safeUnregisterServiceInfoCallback(it) }
            serviceInfoCallbacks.clear()
        }
        fun completeWithCurrentResults(discoveryListener: NsdManager.DiscoveryListener) {
            unregisterServiceInfoCallbacks()
            safeStopDiscovery(discoveryListener)
            discListenerRef.compareAndSet(discoveryListener, null)
            if (!result.isCompleted) result.complete(found.toList())
        }
        fun completeWithError(discoveryListener: NsdManager.DiscoveryListener, error: Throwable) {
            unregisterServiceInfoCallbacks()
            safeStopDiscovery(discoveryListener)
            discListenerRef.compareAndSet(discoveryListener, null)
            if (!result.isCompleted) result.completeExceptionally(error)
        }

        @Suppress("DEPRECATION")
        fun resolveLegacy(si: NsdServiceInfo, discoveryListener: NsdManager.DiscoveryListener) {
            try {
                nsd.resolveService(si, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(s: NsdServiceInfo, errorCode: Int) { /* ignore */ }

                    override fun onServiceResolved(s: NsdServiceInfo) {
                        if (result.isCompleted) return
                        upsert(toMdnsService(s))

                        // Early-exit for exact/prefix target match.
                        if (targetName != null && matchesTarget(s.serviceName)) {
                            completeWithCurrentResults(discoveryListener)
                        }
                    }
                })
            } catch (_: Throwable) {
                // Some Android releases throw when the NSD daemon is busy; ignore this candidate.
            }
        }

        fun registerServiceInfoCallback(si: NsdServiceInfo, discoveryListener: NsdManager.DiscoveryListener) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                resolveLegacy(si, discoveryListener)
                return
            }

            val callback = object : NsdManager.ServiceInfoCallback {
                override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) { /* ignore */ }
                override fun onServiceInfoCallbackUnregistered() { /* no-op */ }
                override fun onServiceLost() { /* no-op */ }

                override fun onServiceUpdated(serviceInfo: NsdServiceInfo) {
                    if (result.isCompleted) return
                    upsert(toMdnsService(serviceInfo))

                    // Early-exit for exact/prefix target match.
                    if (targetName != null && matchesTarget(serviceInfo.serviceName)) {
                        completeWithCurrentResults(discoveryListener)
                    }
                }
            }

            serviceInfoCallbacks.add(callback)
            try {
                nsd.registerServiceInfoCallback(si, mainExecutor, callback)
            } catch (_: Throwable) {
                serviceInfoCallbacks.remove(callback)
            }
        }

        val listener = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                completeWithError(this, IllegalStateException("Discovery failed to start: $errorCode"))
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) { /* no-op */ }
            override fun onDiscoveryStarted(serviceType: String) { /* no-op */ }
            override fun onDiscoveryStopped(serviceType: String) { /* no-op */ }

            override fun onServiceFound(si: NsdServiceInfo) {
                if (result.isCompleted) return
                if (targetName != null && !matchesTarget(si.serviceName)) return

                val discoveryListener = this
                registerServiceInfoCallback(si, discoveryListener)
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) { /* no-op */ }
        }

        // Start discovery and schedule timeout
        discListenerRef.set(listener)
        try {
            nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (t: Throwable) {
            discListenerRef.compareAndSet(listener, null)
            throw t
        }

        val timeoutJob = scope.launch {
            delay(timeoutMs.coerceAtLeast(0).toLong())
            completeWithCurrentResults(listener)
        }

        try {
            result.await()
        } finally {
            // Cleanup in all cases (early-exit or timeout)
            timeoutJob.cancel()
            unregisterServiceInfoCallbacks()
            if (discListenerRef.compareAndSet(listener, null)) safeStopDiscovery(listener)
        }
    } }

    /**
     * Close the manager and release any outstanding NSD listeners.
     * Safe to call multiple times; also invoked by the plugin's handleOnDestroy().
     */
    fun close() {
        runOnMain {
            stopActiveRegistration("mDNS manager closed before publish completed")
            discListenerRef.getAndSet(null)?.let { safeStopDiscovery(it) }
        }
        if (externalScope == null) scope.cancel()
    }

    // ---- Internal helpers ----------------------------------------------------

    /** Best-effort unregister; NSD may throw if already unregistered. */
    private fun safeUnregister(l: NsdManager.RegistrationListener) {
        try { nsd.unregisterService(l) } catch (_: Throwable) {}
    }

    private fun completeRegistrationSuccess(session: RegistrationSession, publishedName: String) {
        if (session.completed) return
        session.completed = true
        session.timeoutJob.cancel()
        session.onSuccess(publishedName)
    }

    private fun completeRegistrationError(
        session: RegistrationSession,
        error: Throwable,
        clearActive: Boolean,
        unregister: Boolean = false
    ) {
        if (session.completed) return
        session.completed = true
        session.timeoutJob.cancel()
        if (unregister) safeUnregister(session.listener)
        if (clearActive && activeRegistration === session) activeRegistration = null
        session.onError(error)
    }

    private fun stopActiveRegistration(reason: String) {
        val session = activeRegistration ?: return
        activeRegistration = null
        safeUnregister(session.listener)
        if (!session.completed) {
            completeRegistrationError(session, IllegalStateException(reason), clearActive = false)
        } else {
            session.timeoutJob.cancel()
        }
    }

    /** Best-effort stop discovery; NSD may throw if discovery is not active. */
    private fun safeStopDiscovery(l: NsdManager.DiscoveryListener) {
        try { nsd.stopServiceDiscovery(l) } catch (_: Throwable) {}
    }

    /** Best-effort stop service info updates; NSD may throw if not registered. */
    private fun safeUnregisterServiceInfoCallback(l: NsdManager.ServiceInfoCallback) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try { nsd.unregisterServiceInfoCallback(l) } catch (_: Throwable) {}
        }
    }

    private fun toMdnsService(s: NsdServiceInfo): MdnsService =
        MdnsService(
            name = s.serviceName,
            type = s.serviceType,
            hosts = hostAddresses(s),
            port = s.port
        )

    private fun hostAddresses(s: NsdServiceInfo): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            s.hostAddresses.mapNotNull { it.hostAddress }
        } else {
            legacyHostAddress(s)?.let { listOf(it) } ?: emptyList()
        }

    @Suppress("DEPRECATION")
    private fun legacyHostAddress(s: NsdServiceInfo): String? = s.host?.hostAddress
}
